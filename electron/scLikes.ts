export const SC_PARTITION = 'persist:soundcloud';

const AUTH_COOKIES_TO_CLEAR = ['oauth_token', 'oauth_refresh_token', 'sc_session'] as const;
const TRACK_LIKES_FILTER = { urls: ['*://api-v2.soundcloud.com/*/track_likes/*'] };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScLikeRequest {
  uid: string;
  scId: string;
  scUrl: string;
  liked: boolean;
  oauthToken: string;
  clientId: string;
  appVersion: string;
}

export type ScLikeResult =
  | { status: 'ok'; liked: 'liked' | 'unliked'; verified?: boolean }
  | { status: 'unauthorized'; message?: string }
  | { status: 'cancelled'; message?: string }
  | { status: 'error'; message: string };

export type ScLoginResult =
  | { status: 'ok'; token: string }
  | { status: 'cancelled' };

export interface ScCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface ScCookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
}

export interface ScFetchResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface ScBeforeSendHeadersDetails {
  url: string;
  requestHeaders: Record<string, string>;
}

export interface ScBeforeRequestDetails {
  url: string;
}

export interface ScCompletedDetails {
  url: string;
  method: string;
  statusCode: number;
}

export type ScClearStorageOption = 'serviceworkers';

export interface ScSessionLike {
  setUserAgent(userAgent: string): void;
  fetch(input: string, init?: RequestInit): Promise<ScFetchResponse>;
  cookies: {
    get(filter: { name?: string; url?: string; domain?: string }): Promise<ScCookie[]>;
    set(details: ScCookieSetDetails): Promise<void>;
    remove(url: string, name: string): Promise<void>;
    flushStore(): Promise<void>;
  };
  clearStorageData(options?: { storages?: ScClearStorageOption[] }): Promise<void>;
  webRequest: {
    onBeforeSendHeaders(
      listener:
        | ((
            details: ScBeforeSendHeadersDetails,
            callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void
          ) => void)
        | null
    ): void;
    onBeforeRequest(
      listener:
        | ((
            details: ScBeforeRequestDetails,
            callback: (response: { cancel?: boolean }) => void
          ) => void)
        | null
    ): void;
    onCompleted(
      filter: { urls: string[] },
      listener: ((details: ScCompletedDetails) => void) | null
    ): void;
  };
}

export interface ScPopupWindowOptions<TSession extends ScSessionLike = ScSessionLike> {
  width?: number;
  height?: number;
  autoHideMenuBar?: boolean;
  webPreferences?: {
    session?: TSession;
    sandbox?: boolean;
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
  };
}

export type ScWindowOpenHandlerResponse<TSession extends ScSessionLike = ScSessionLike> =
  | { action: 'deny' }
  | { action: 'allow'; overrideBrowserWindowOptions?: ScPopupWindowOptions<TSession> };

export interface ScWindowLike<TSession extends ScSessionLike = ScSessionLike> {
  isDestroyed(): boolean;
  destroy(): void;
  show(): void;
  moveTop(): void;
  focus(): void;
  loadURL(url: string): Promise<void>;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
  webContents: {
    setUserAgent(userAgent: string): void;
    setAudioMuted(muted: boolean): void;
    setWindowOpenHandler(
      handler: (details: { url: string }) => ScWindowOpenHandlerResponse<TSession>
    ): void;
    on(event: 'did-create-window', listener: (childWindow: ScWindowLike<TSession>) => void): unknown;
  };
}

export interface ScWindowOptions<TSession extends ScSessionLike = ScSessionLike> {
  x: number;
  y: number;
  width: number;
  height: number;
  show: boolean;
  title: string;
  autoHideMenuBar: boolean;
  session: TSession;
  userAgent: string;
}

export interface ScLikesDeps<TSession extends ScSessionLike = ScSessionLike> {
  getSession: (partition: string) => TSession;
  createWindow: (options: ScWindowOptions<TSession>) => ScWindowLike<TSession>;
  getMainBounds: () => Rect | null;
  getWorkAreaForBounds: (bounds: Rect | null) => Rect;
  isShuttingDown: () => boolean;
  chromeVersion?: string;
  log?: (message: string) => void;
  fetchTimeoutMs?: number;
  verifyTimeoutMs?: number;
  verifyPollIntervalMs?: number;
  verifySettleDelayMs?: number;
  loginPollIntervalMs?: number;
  loginSettleDelayMs?: number;
}

export interface ScLikesController {
  login: () => Promise<ScLoginResult>;
  logout: () => Promise<{ status: 'ok' }>;
  like: (req: ScLikeRequest) => Promise<ScLikeResult>;
  dispose: () => void;
}

type DirectLikeOutcome =
  | { kind: 'done'; result: ScLikeResult }
  | { kind: 'datadome' };

type VerifyOutcome =
  | { status: 'verified'; ownerCompleted: boolean }
  | { status: 'unauthorized'; message: string }
  | { status: 'cancelled'; message: string }
  | { status: 'error'; message: string };

export function computeCenteredBounds(
  mainBounds: Rect | null,
  workArea: Rect,
  width: number,
  height: number
): Rect {
  const clampedWidth = Math.max(1, Math.round(Math.min(width, workArea.width)));
  const clampedHeight = Math.max(1, Math.round(Math.min(height, workArea.height)));
  const anchor = mainBounds ?? workArea;

  const rawX = Math.round(anchor.x + (anchor.width - clampedWidth) / 2);
  const rawY = Math.round(anchor.y + (anchor.height - clampedHeight) / 2);

  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - clampedWidth;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - clampedHeight;

  return {
    x: Math.min(Math.max(rawX, minX), maxX),
    y: Math.min(Math.max(rawY, minY), maxY),
    width: clampedWidth,
    height: clampedHeight,
  };
}

export function isDataDomeChallenge(
  status: number,
  headers: Record<string, string | undefined>,
  bodyText: string
): boolean {
  if (status !== 403) return false;
  for (const [key, val] of Object.entries(headers)) {
    if (!val) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'x-datadome' || lowerKey === 'x-dd-b') {
      return true;
    }
  }
  const lowerBody = (bodyText || '').toLowerCase();
  return lowerBody.includes('captcha-delivery') || lowerBody.includes('datadome');
}

function buildCookieUrl(cookie: ScCookie): string {
  const rawDomain = (cookie.domain || 'soundcloud.com').replace(/^\./, '');
  const path = cookie.path || '/';
  return `https://${rawDomain}${path.startsWith('/') ? path : `/${path}`}`;
}

function pickSoundCloudCookie(cookies: ScCookie[]): ScCookie | undefined {
  return cookies.find((c) => !c.domain || c.domain.includes('soundcloud.com')) || cookies[0];
}

function isLogoutUrl(url: string, allowedTargetUrl: string | null): boolean {
  if (allowedTargetUrl && url === allowedTargetUrl) return false;
  const lower = url.toLowerCase();
  if (lower.includes('oauth2/revoke')) return true;
  try {
    const parsed = new URL(url);
    return /(^|\/)(logout|signout|sign-out)(\/|$)/i.test(parsed.pathname);
  } catch {
    return lower.includes('logout') || lower.includes('signout') || lower.includes('sign-out');
  }
}

function isAllowedPopupUrl(url: string): boolean {
  if (!url || url === 'about:blank') return true;
  return url.startsWith('https://') || url.startsWith('http://');
}

function matchesTrackLikeCompleted(
  details: ScCompletedDetails,
  targetScId: string,
  expectedMethod: 'PUT' | 'DELETE'
): boolean {
  if (details.statusCode < 200 || details.statusCode >= 300) return false;
  if (details.method.toUpperCase() !== expectedMethod) return false;
  const match = details.url.match(/\/track_likes\/([^/?#]+)/);
  if (!match) return false;
  try {
    return decodeURIComponent(match[1]) === targetScId || match[1] === targetScId;
  } catch {
    return match[1] === targetScId;
  }
}

function buildTrackLikeUrl(req: ScLikeRequest): string {
  return (
    `https://api-v2.soundcloud.com/users/${encodeURIComponent(req.uid)}/track_likes/${encodeURIComponent(req.scId)}` +
    `?client_id=${encodeURIComponent(req.clientId)}` +
    `&app_version=${encodeURIComponent(req.appVersion)}` +
    `&app_locale=en`
  );
}

function buildVerifyPageUrl(req: ScLikeRequest): string {
  if (req.scUrl && req.scUrl.startsWith('https://soundcloud.com/')) {
    return req.scUrl;
  }
  return `https://soundcloud.com/tracks/${encodeURIComponent(req.scId)}`;
}

export function createScLikesController<TSession extends ScSessionLike = ScSessionLike>(
  deps: ScLikesDeps<TSession>
): ScLikesController {
  const chromeVer = deps.chromeVersion || process.versions.chrome || '122.0.0.0';
  const chromeMajor = chromeVer.split('.')[0];
  const winUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  const chUa = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not.A/Brand";v="24"`;

  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 15_000;
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? 180_000;
  const verifyPollIntervalMs = deps.verifyPollIntervalMs ?? 1_500;
  const verifySettleDelayMs = deps.verifySettleDelayMs ?? 800;
  const loginPollIntervalMs = deps.loginPollIntervalMs ?? 1_000;
  const loginSettleDelayMs = deps.loginSettleDelayMs ?? 800;

  let cachedSession: TSession | null = null;
  let logoutGuardActive = false;
  let activeVerifyTargetUrl: string | null = null;
  let disposed = false;
  let logoutGeneration = 0;

  let activeLoginPromise: Promise<ScLoginResult> | null = null;
  let activeLoginWin: ScWindowLike<TSession> | null = null;
  let cancelActiveLogin: (() => void) | null = null;

  let verifyPromise: Promise<VerifyOutcome> | null = null;
  let cancelActiveVerify: (() => void) | null = null;

  function isCancelledEnvironment(): boolean {
    return disposed || deps.isShuttingDown();
  }

  function getConfiguredSession(): TSession {
    if (cachedSession) return cachedSession;
    const sess = deps.getSession(SC_PARTITION);
    sess.setUserAgent(winUa);
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders;
      h['User-Agent'] = winUa;
      h['sec-ch-ua'] = chUa;
      h['sec-ch-ua-mobile'] = '?0';
      h['sec-ch-ua-platform'] = '"Windows"';
      callback({ requestHeaders: h });
    });
    // Единый session-level перехватчик с флагом, чтобы не перетирать слушатели при открытии/закрытии окна проверки.
    sess.webRequest.onBeforeRequest((details, callback) => {
      if (logoutGuardActive && isLogoutUrl(details.url, activeVerifyTargetUrl)) {
        callback({ cancel: true });
        return;
      }
      callback({});
    });
    cachedSession = sess;
    return sess;
  }

  async function clearScServiceWorkers(sess: TSession): Promise<void> {
    try {
      // Удаляем только serviceworkers (без cookies), чтобы после закрытия окна не оставался фоновый рендерер.
      await sess.clearStorageData({ storages: ['serviceworkers'] });
    } catch {
      // ignore
    }
  }

  async function readCookieValue(sess: TSession, name: string): Promise<string> {
    try {
      const list = await sess.cookies.get({ name });
      return pickSoundCloudCookie(list)?.value || '';
    } catch {
      return '';
    }
  }

  async function ensureOAuthCookie(sess: TSession, oauthToken: string): Promise<void> {
    const current = await readCookieValue(sess, 'oauth_token');
    if (current === oauthToken) return;
    // Указываем domain '.soundcloud.com', чтобы кука отправлялась и на api-v2.soundcloud.com.
    await sess.cookies.set({
      url: 'https://soundcloud.com',
      domain: '.soundcloud.com',
      name: 'oauth_token',
      value: oauthToken,
      path: '/',
      secure: true,
    });
    await sess.cookies.flushStore();
  }

  async function removeStaleAuthCookies(sess: TSession): Promise<void> {
    // Сбрасываем только auth-куки, не трогая datadome, чтобы избежать тупика перелогина после 401 и не терять проверку DataDome.
    for (const name of AUTH_COOKIES_TO_CLEAR) {
      try {
        const list = await sess.cookies.get({ name });
        for (const cookie of list) {
          await sess.cookies.remove(buildCookieUrl(cookie), cookie.name);
        }
      } catch {
        // ignore
      }
    }
  }

  function attachPopupHandling(
    win: ScWindowLike<TSession>,
    sess: TSession,
    childWindows: Set<ScWindowLike<TSession>>
  ): void {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedPopupUrl(url)) {
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            session: sess,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    });

    win.webContents.on('did-create-window', (childWin) => {
      childWindows.add(childWin);
      childWin.webContents.setUserAgent(winUa);
      attachPopupHandling(childWin, sess, childWindows);
      childWin.once('closed', () => {
        childWindows.delete(childWin);
      });
    });
  }

  function destroyWindowTree(
    mainWin: ScWindowLike<TSession> | null,
    childWindows: Set<ScWindowLike<TSession>>
  ): void {
    for (const child of Array.from(childWindows)) {
      if (!child.isDestroyed()) child.destroy();
    }
    childWindows.clear();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.destroy();
    }
  }

  async function executeDirectLike(sess: TSession, req: ScLikeRequest): Promise<DirectLikeOutcome> {
    const method: 'PUT' | 'DELETE' = req.liked ? 'PUT' : 'DELETE';
    const likedLabel: 'liked' | 'unliked' = req.liked ? 'liked' : 'unliked';
    const url = buildTrackLikeUrl(req);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

    try {
      const resp = await sess.fetch(url, {
        method,
        headers: {
          Authorization: `OAuth ${req.oauthToken}`,
          Origin: 'https://soundcloud.com',
          Referer: 'https://soundcloud.com/',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        credentials: 'include',
        signal: controller.signal,
      });

      if (resp.ok || (!req.liked && resp.status === 404)) {
        return { kind: 'done', result: { status: 'ok', liked: likedLabel, verified: false } };
      }

      if (resp.status === 401) {
        return { kind: 'done', result: { status: 'unauthorized', message: 'HTTP 401' } };
      }

      let bodyText = '';
      try {
        bodyText = await resp.text();
      } catch {
        bodyText = '';
      }

      const headerMap: Record<string, string | undefined> = {
        'x-datadome': resp.headers.get('x-datadome') ?? undefined,
        'x-dd-b': resp.headers.get('x-dd-b') ?? undefined,
      };

      if (isDataDomeChallenge(resp.status, headerMap, bodyText)) {
        return { kind: 'datadome' };
      }

      return { kind: 'done', result: { status: 'error', message: `HTTP ${resp.status}` } };
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const message = isAbort
        ? 'Request timed out'
        : err instanceof Error
          ? err.message
          : String(err);
      return { kind: 'done', result: { status: 'error', message } };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function runVerificationModal(sess: TSession, ownerReq: ScLikeRequest): Promise<VerifyOutcome> {
    const childWindows = new Set<ScWindowLike<TSession>>();
    let verifyWin: ScWindowLike<TSession> | null = null;
    let cancelledExternally = false;
    let resolveWait: ((outcome: VerifyOutcome) => void) | null = null;

    cancelActiveVerify = () => {
      cancelledExternally = true;
      destroyWindowTree(verifyWin, childWindows);
      resolveWait?.({ status: 'cancelled', message: 'Verification cancelled' });
    };

    return (async (): Promise<VerifyOutcome> => {
      let settled = false;
      let completing = false;
      let pollingBusy = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let onClosed: (() => void) | null = null;

      try {
        if (isCancelledEnvironment() || cancelledExternally) {
          return { status: 'cancelled', message: 'Verification cancelled' };
        }

        const initialDatadome = await readCookieValue(sess, 'datadome');
        if (isCancelledEnvironment() || cancelledExternally) {
          return { status: 'cancelled', message: 'Verification cancelled' };
        }
        let lastTriedDatadome = initialDatadome;

        const targetUrl = buildVerifyPageUrl(ownerReq);
        const mainBounds = deps.getMainBounds();
        const workArea = deps.getWorkAreaForBounds(mainBounds);
        const bounds = computeCenteredBounds(mainBounds, workArea, 960, 760);

        logoutGuardActive = true;
        activeVerifyTargetUrl = targetUrl;

        verifyWin = deps.createWindow({
          ...bounds,
          show: true,
          title: 'SoundCloud - Confirm action',
          autoHideMenuBar: true,
          session: sess,
          userAgent: winUa,
        });
        verifyWin.webContents.setUserAgent(winUa);
        verifyWin.webContents.setAudioMuted(true);
        attachPopupHandling(verifyWin, sess, childWindows);
        verifyWin.show();
        verifyWin.moveTop();
        verifyWin.focus();

        const expectedMethod: 'PUT' | 'DELETE' = ownerReq.liked ? 'PUT' : 'DELETE';

        const outcome = await new Promise<VerifyOutcome>((resolve) => {
          const finish = (res: VerifyOutcome) => {
            if (settled) return;
            settled = true;
            if (pollTimer) clearInterval(pollTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (settleTimer) clearTimeout(settleTimer);
            resolve(res);
          };

          resolveWait = finish;

          sess.webRequest.onCompleted(TRACK_LIKES_FILTER, (details) => {
            if (settled || completing) return;
            if (matchesTrackLikeCompleted(details, ownerReq.scId, expectedMethod)) {
              completing = true;
              settleTimer = setTimeout(() => {
                finish({ status: 'verified', ownerCompleted: true });
              }, verifySettleDelayMs);
            }
          });

          const tryPollRetry = async () => {
            if (settled || completing || pollingBusy || cancelledExternally || isCancelledEnvironment()) {
              return;
            }
            pollingBusy = true;
            try {
              const currentDatadome = await readCookieValue(sess, 'datadome');
              if (settled || completing || !currentDatadome || currentDatadome === lastTriedDatadome) {
                return;
              }
              const retry = await executeDirectLike(sess, ownerReq);
              if (settled || completing) return;
              if (retry.kind === 'done') {
                if (retry.result.status === 'ok') {
                  finish({ status: 'verified', ownerCompleted: true });
                  return;
                }
                if (retry.result.status === 'unauthorized') {
                  finish({ status: 'unauthorized', message: retry.result.message || 'HTTP 401' });
                  return;
                }
              }
              // Фиксируем уже проверенную куку (с учетом возможного Set-Cookie от 403),
              // чтобы не дергать api-v2 на каждом тике опроса с нерешенной капчей.
              lastTriedDatadome = (await readCookieValue(sess, 'datadome')) || currentDatadome;
            } finally {
              pollingBusy = false;
            }
          };

          pollTimer = setInterval(() => {
            void tryPollRetry();
          }, verifyPollIntervalMs);

          timeoutTimer = setTimeout(() => {
            finish({ status: 'cancelled', message: 'Verification timed out' });
          }, verifyTimeoutMs);

          onClosed = () => {
            if (settled || completing) return;
            completing = true;
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = undefined;
            }
            if (cancelledExternally || isCancelledEnvironment()) {
              finish({ status: 'cancelled', message: 'Verification cancelled' });
              return;
            }
            // Если пользователь прошел капчу и закрыл окно до тика опроса, делаем одну тихую проверку sess.fetch.
            void (async () => {
              const currentDatadome = await readCookieValue(sess, 'datadome');
              if (settled || cancelledExternally || isCancelledEnvironment()) {
                finish({ status: 'cancelled', message: 'Verification cancelled' });
                return;
              }
              if (currentDatadome && currentDatadome !== lastTriedDatadome) {
                const finalTry = await executeDirectLike(sess, ownerReq);
                if (settled || cancelledExternally || isCancelledEnvironment()) {
                  finish({ status: 'cancelled', message: 'Verification cancelled' });
                  return;
                }
                if (finalTry.kind === 'done') {
                  if (finalTry.result.status === 'ok') {
                    finish({ status: 'verified', ownerCompleted: true });
                    return;
                  }
                  if (finalTry.result.status === 'unauthorized') {
                    finish({ status: 'unauthorized', message: finalTry.result.message || 'HTTP 401' });
                    return;
                  }
                }
              }
              finish({ status: 'cancelled', message: 'Verification cancelled' });
            })();
          };

          verifyWin!.once('closed', onClosed);
          verifyWin!.loadURL(targetUrl).catch(() => {
            // Загрузка может прерваться при закрытии или уничтожении окна.
          });
        });

        return outcome;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log?.(`[soundcloud] verify modal error: ${message}`);
        return { status: 'error', message };
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (verifyWin && onClosed) {
          verifyWin.removeListener('closed', onClosed);
        }
        try {
          sess.webRequest.onCompleted(TRACK_LIKES_FILTER, null);
        } catch {
          // ignore
        }
        logoutGuardActive = false;
        activeVerifyTargetUrl = null;
        try {
          await sess.cookies.flushStore();
        } catch {
          // ignore
        }
        destroyWindowTree(verifyWin, childWindows);
        await clearScServiceWorkers(sess);
        resolveWait = null;
        cancelActiveVerify = null;
        verifyPromise = null;
      }
    })();
  }

  async function like(req: ScLikeRequest): Promise<ScLikeResult> {
    const startLogoutGen = logoutGeneration;
    if (isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'App is shutting down' };
    }
    if (!req.oauthToken) {
      return { status: 'unauthorized', message: 'Missing oauth_token' };
    }
    if (!req.uid || !req.scId || !req.clientId) {
      return { status: 'error', message: 'Missing SoundCloud request parameters' };
    }

    const sess = getConfiguredSession();
    try {
      await ensureOAuthCookie(sess, req.oauthToken);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'error', message: `Failed to sync oauth_token cookie: ${message}` };
    }

    if (logoutGeneration !== startLogoutGen) {
      return { status: 'cancelled', message: 'Logged out' };
    }

    const first = await executeDirectLike(sess, req);
    if (logoutGeneration !== startLogoutGen) {
      return { status: 'cancelled', message: 'Logged out' };
    }
    if (first.kind === 'done') {
      return first.result;
    }

    // Single-flight мьютекс: параллельные 403 DataDome разделяют одно окно проверки.
    let isOwner = false;
    let activeVerify = verifyPromise;
    if (!activeVerify) {
      isOwner = true;
      activeVerify = runVerificationModal(sess, req);
      verifyPromise = activeVerify;
    }

    const outcome = await activeVerify;
    if (logoutGeneration !== startLogoutGen) {
      return { status: 'cancelled', message: 'Logged out' };
    }
    const likedLabel: 'liked' | 'unliked' = req.liked ? 'liked' : 'unliked';

    if (outcome.status === 'cancelled') {
      return { status: 'cancelled', message: outcome.message };
    }
    if (outcome.status === 'unauthorized') {
      return { status: 'unauthorized', message: outcome.message };
    }
    if (outcome.status === 'error') {
      return { status: 'error', message: outcome.message };
    }

    if (isOwner && outcome.ownerCompleted) {
      return { status: 'ok', liked: likedLabel, verified: true };
    }

    const retry = await executeDirectLike(sess, req);
    if (logoutGeneration !== startLogoutGen) {
      return { status: 'cancelled', message: 'Logged out' };
    }
    if (retry.kind === 'done') {
      if (retry.result.status === 'ok') {
        return { ...retry.result, verified: true };
      }
      return retry.result;
    }

    return { status: 'error', message: 'DataDome verification required' };
  }

  function login(): Promise<ScLoginResult> {
    if (isCancelledEnvironment()) {
      return Promise.resolve({ status: 'cancelled' });
    }
    if (activeLoginPromise) {
      if (activeLoginWin && !activeLoginWin.isDestroyed()) {
        activeLoginWin.show();
        activeLoginWin.moveTop();
        activeLoginWin.focus();
      }
      return activeLoginPromise;
    }

    const childWindows = new Set<ScWindowLike<TSession>>();
    let loginWin: ScWindowLike<TSession> | null = null;
    let cancelledExternally = false;
    let resolveWait: ((result: ScLoginResult) => void) | null = null;

    cancelActiveLogin = () => {
      cancelledExternally = true;
      destroyWindowTree(loginWin, childWindows);
      resolveWait?.({ status: 'cancelled' });
    };

    const sess = getConfiguredSession();

    const promise = (async (): Promise<ScLoginResult> => {
      let settled = false;
      let capturing = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let onClosed: (() => void) | null = null;
      let result: ScLoginResult = { status: 'cancelled' };

      try {
        await removeStaleAuthCookies(sess);
        if (isCancelledEnvironment() || cancelledExternally) {
          return { status: 'cancelled' };
        }

        const mainBounds = deps.getMainBounds();
        const workArea = deps.getWorkAreaForBounds(mainBounds);
        const bounds = computeCenteredBounds(mainBounds, workArea, 980, 760);

        loginWin = deps.createWindow({
          ...bounds,
          show: true,
          title: 'Sign in to SoundCloud',
          autoHideMenuBar: true,
          session: sess,
          userAgent: winUa,
        });
        activeLoginWin = loginWin;
        loginWin.webContents.setUserAgent(winUa);
        loginWin.webContents.setAudioMuted(true);
        attachPopupHandling(loginWin, sess, childWindows);
        loginWin.show();
        loginWin.moveTop();
        loginWin.focus();

        result = await new Promise<ScLoginResult>((resolve) => {
          const finish = (res: ScLoginResult) => {
            if (settled) return;
            settled = true;
            if (pollTimer) clearInterval(pollTimer);
            if (settleTimer) clearTimeout(settleTimer);
            resolve(res);
          };

          resolveWait = finish;

          onClosed = () => {
            if (!capturing) {
              finish({ status: 'cancelled' });
            }
          };

          const checkToken = async () => {
            if (settled || capturing || cancelledExternally || isCancelledEnvironment()) return;
            const tok = await readCookieValue(sess, 'oauth_token');
            if (settled || capturing || cancelledExternally || isCancelledEnvironment()) return;
            if (tok) {
              capturing = true;
              if (pollTimer) clearInterval(pollTimer);
              settleTimer = setTimeout(() => {
                if (cancelledExternally || isCancelledEnvironment()) {
                  finish({ status: 'cancelled' });
                  return;
                }
                void readCookieValue(sess, 'oauth_token').then((latest) => {
                  finish({ status: 'ok', token: latest || tok });
                });
              }, loginSettleDelayMs);
            }
          };

          loginWin!.once('closed', onClosed);
          pollTimer = setInterval(() => {
            void checkToken();
          }, loginPollIntervalMs);
          loginWin!.loadURL('https://soundcloud.com/signin').catch(() => {
            // Загрузка может прерваться при закрытии или уничтожении окна.
          });
          void checkToken();
        });

        return result;
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (loginWin && onClosed) {
          loginWin.removeListener('closed', onClosed);
        }
        if (result.status === 'ok') {
          try {
            await sess.cookies.flushStore();
          } catch {
            // ignore
          }
        }
        destroyWindowTree(loginWin, childWindows);
        await clearScServiceWorkers(sess);
        activeLoginWin = null;
        resolveWait = null;
        cancelActiveLogin = null;
        activeLoginPromise = null;
      }
    })();

    activeLoginPromise = promise;
    return promise;
  }

  async function logout(): Promise<{ status: 'ok' }> {
    logoutGeneration += 1;
    const pendingLogin = activeLoginPromise;
    const pendingVerify = verifyPromise;

    cancelActiveLogin?.();
    cancelActiveVerify?.();

    if (pendingLogin) {
      try {
        await pendingLogin;
      } catch {
        // ignore
      }
    }
    if (pendingVerify) {
      try {
        await pendingVerify;
      } catch {
        // ignore
      }
    }

    const sess = getConfiguredSession();
    try {
      await sess.clearStorageData();
    } catch {
      // ignore
    }
    return { status: 'ok' };
  }

  function dispose(): void {
    disposed = true;
    cancelActiveLogin?.();
    cancelActiveVerify?.();
  }

  return {
    login,
    logout,
    like,
    dispose,
  };
}
