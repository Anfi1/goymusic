import { registerPlugin } from '@capacitor/core';

// Плагин поднимает python/api.py через Chaquopy и гоняет тот же JSON-протокол,
// что и десктопный preload: наверх строка запроса, обратно строки ответов.
interface PythonBackendPlugin {
  send(options: { line: string }): Promise<void>;
  status(): Promise<{ ready: boolean; error?: string }>;
  youtubeLogin(): Promise<{ status: string }>;
  importAuth(options: { json: string }): Promise<{ status: string }>;
  addListener(event: 'pyLine', cb: (data: { line: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'pyReady', cb: (data: { ok: boolean; error?: string }) => void): Promise<{ remove: () => void }>;
}

const Native = registerPlugin<PythonBackendPlugin>('PythonBackend');

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

const pending = new Map<string, Pending>();
const eventListeners = new Set<(msg: any) => void>();

let readyResolve: ((ok: boolean) => void) | null = null;
const readyPromise = new Promise<boolean>(r => { readyResolve = r; });
let readyState: boolean | null = null;
let startError: string | null = null;

function settleReady(ok: boolean) {
  if (readyState !== null) return;
  readyState = ok;
  readyResolve?.(ok);
}

export function initNativeBackend(): void {
  Native.addListener('pyLine', ({ line }) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const callId = msg?.callId;
    const waiter = callId ? pending.get(callId) : undefined;
    if (waiter) {
      // Прогресс-сообщения (status: 'progress') приходят по тому же callId и ответом
      // не являются -- иначе download_track завершался бы на первом же проценте.
      if (msg.status === 'progress') {
        for (const l of eventListeners) l(msg);
        return;
      }
      pending.delete(callId);
      waiter.resolve(msg);
      return;
    }
    for (const l of eventListeners) l(msg);
  }).catch(() => {});

  Native.addListener('pyReady', ({ ok, error }) => {
    if (!ok) startError = error || 'python failed to start';
    settleReady(ok);
  }).catch(() => settleReady(false));

  // Плагин мог подняться раньше, чем вебвью успела подписаться на событие.
  Native.status().then(s => {
    if (s.ready) settleReady(true);
    else if (s.error) { startError = s.error; settleReady(false); }
  }).catch(() => {});

  // Если питон не ответил за 40с -- считаем, что его нет, и уходим на JS-реализацию.
  setTimeout(() => settleReady(false), 40000);
}

export function nativeReady(): Promise<boolean> {
  return readyState !== null ? Promise.resolve(readyState) : readyPromise;
}

export function nativeStartError(): string | null {
  return startError;
}

export function onNativeEvent(cb: (msg: any) => void): () => void {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

let counter = 0;

export function nativeCall(command: string, args: any = {}): Promise<any> {
  const callId = `m${Date.now().toString(36)}${(counter++).toString(36)}`;
  const line = JSON.stringify({ ...args, command, callId });
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    Native.send({ line }).catch(err => {
      pending.delete(callId);
      reject(err);
    });
  });
}

export function nativeYoutubeLogin(): Promise<{ status: string }> {
  return Native.youtubeLogin();
}

export function nativeImportAuth(json: string): Promise<{ status: string }> {
  return Native.importAuth({ json });
}

export function nativeCancel(callId: string): void {
  pending.delete(callId);
  // api.py помечает отменённой задачу с ТЕМ ЖЕ callId, что и у отменяемого вызова.
  Native.send({ line: JSON.stringify({ command: 'cancel', callId }) }).catch(() => {});
}
