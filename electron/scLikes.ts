import {
  extractScJwtClientId,
  isScJwtNewer,
  isScTokenExpiringSoon,
  parseScJwt,
  SC_PROACTIVE_REFRESH_LEEWAY_SEC,
} from '../src/utils/scJwt';

export const SC_PARTITION = 'persist:soundcloud';

const AUTH_COOKIES_TO_CLEAR = ['oauth_token', 'oauth_refresh_token', 'sc_session'] as const;
const TRACK_LIKES_FILTER = { urls: ['*://api-v2.soundcloud.com/*/track_likes/*'] };
const SC_REFRESH_PROXY_URL = 'https://soundcloud.com/n/api/refresh-token';
const SC_OAUTH_TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const OAUTH_TOKEN_TTL_DAYS = 365;
const REFRESH_TOKEN_TTL_DAYS = 182;
const PROACTIVE_REFRESH_LEEWAY_SEC = SC_PROACTIVE_REFRESH_LEEWAY_SEC;
const FRESH_COOKIE_LEEWAY_SEC = 30;

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
  skipRefresh?: boolean;
}

export type ScLikeResult =
  | { status: 'ok'; liked: 'liked' | 'unliked'; verified?: boolean; refreshedToken?: string }
  | { status: 'unauthorized'; message?: string; refreshedToken?: string }
  | { status: 'cancelled'; message?: string }
  | { status: 'error'; message: string; refreshedToken?: string };

export type ScLoginResult =
  | { status: 'ok'; token: string }
  | { status: 'cancelled' };

export interface ScRefreshRequest {
  failedToken?: string;
  clientId?: string;
  force?: boolean;
}

export type ScRefreshResult =
  | { status: 'ok'; token: string }
  | { status: 'no_refresh_token' }
  | { status: 'unauthorized'; message?: string }
  | { status: 'cancelled'; message?: string }
  | { status: 'error'; message: string };

export interface ScSetTokensRequest {
  oauthToken: string;
  refreshToken?: string;
}

export type ScSetTokensResult =
  | { status: 'ok' }
  | { status: 'error'; message: string };

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
  httpOnly?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
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
    on(event: 'dom-ready' | 'did-finish-load', listener: () => void): unknown;
    executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
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
  refresh: (req?: ScRefreshRequest) => Promise<ScRefreshResult>;
  setTokens: (req: ScSetTokensRequest) => Promise<ScSetTokensResult>;
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

function isSoundCloudCookieDomain(domain?: string): boolean {
  if (!domain) return true;
  const lower = domain.toLowerCase();
  return lower === 'soundcloud.com' || lower === '.soundcloud.com' || lower.endsWith('.soundcloud.com');
}

function pickSoundCloudCookie(cookies: ScCookie[], previousValue?: string): ScCookie | undefined {
  const scCookies = cookies.filter((c) => isSoundCloudCookieDomain(c.domain));
  const scoped = scCookies.length > 0 ? scCookies : cookies;
  const nonEmpty = scoped.filter((c) => Boolean(c.value));
  const pool = nonEmpty.length > 0 ? nonEmpty : scoped;

  // Если знаем предыдущее значение до refresh, в первую очередь выбираем измененную (свежеротированную) куку,
  // независимо от того, пришла ли она с host-only soundcloud.com или .soundcloud.com.
  if (previousValue) {
    const rotated = pool.filter((c) => c.value && c.value !== previousValue);
    if (rotated.length > 0) {
      return (
        rotated.find((c) => c.domain === 'soundcloud.com') ||
        rotated.find((c) => c.domain === '.soundcloud.com') ||
        rotated[0]
      );
    }
  }

  // При нескольких JWT-куках выбираем куку с максимальным exp.
  let bestJwt: ScCookie | undefined;
  let bestExp = -Infinity;
  for (const c of pool) {
    const exp = parseScJwt(c.value)?.exp;
    if (typeof exp === 'number' && exp > bestExp) {
      bestExp = exp;
      bestJwt = c;
    }
  }
  if (bestJwt) return bestJwt;

  return (
    pool.find((c) => c.domain === 'soundcloud.com') ||
    pool.find((c) => c.domain === '.soundcloud.com') ||
    pool[0]
  );
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

export function getVerifyWindowTitle(liked: boolean): string {
  return liked
    ? 'SoundCloud: нажмите лайк вручную (разовая проверка)'
    : 'SoundCloud: снимите лайк вручную (разовая проверка)';
}

// Скрипт ненавязчивого баннера в окне проверки: использует Shadow DOM, чтобы стили SoundCloud не ломали верстку.
export function buildVerifyHintScript(liked: boolean): string {
  const title = 'Разовая проверка SoundCloud';
  const actionText = liked
    ? 'Нажмите лайк на треке вручную и пройдите проверку, если она появится.'
    : 'Снимите лайк с трека вручную и пройдите проверку, если она появится.';
  const body =
    `Окно открылось из-за защитной проверки SoundCloud. ${actionText} ` +
    'После подтверждения окно закроется само, а в следующие разы лайки будут срабатывать быстро и без этого окна.';

  return `(() => {
    try {
      if (window.__goymusicScVerifyHintDismissed) return;
      if (document.getElementById('__goymusic-sc-verify-hint')) return;
      const rootParent = document.documentElement || document.body;
      if (!rootParent) return;
      const host = document.createElement('div');
      host.id = '__goymusic-sc-verify-hint';
      host.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 32px);width:580px;pointer-events:auto;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = \`
        .card {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 13px 16px;
          border-radius: 12px;
          background: rgba(18, 18, 22, 0.94);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.16);
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
          color: #f4f4f6;
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
          line-height: 1.42;
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: #ff5500;
          flex: 0 0 auto;
          margin-top: 5px;
          box-shadow: 0 0 10px rgba(255, 85, 0, 0.7);
        }
        .content { flex: 1 1 auto; min-width: 0; }
        .title { font-size: 13px; font-weight: 600; color: #ffffff; margin: 0 0 3px 0; }
        .body { font-size: 12.5px; color: rgba(244, 244, 246, 0.84); margin: 0; }
        .close {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.14);
          color: rgba(244, 244, 246, 0.85);
          border-radius: 8px;
          padding: 4px 9px;
          font-size: 12px;
          cursor: pointer;
          flex: 0 0 auto;
        }
        .close:hover { background: rgba(255, 255, 255, 0.16); color: #ffffff; }
      \`;
      const card = document.createElement('div');
      card.className = 'card';
      const dot = document.createElement('div');
      dot.className = 'dot';
      const content = document.createElement('div');
      content.className = 'content';
      const h = document.createElement('div');
      h.className = 'title';
      h.textContent = ${JSON.stringify(title)};
      const p = document.createElement('div');
      p.className = 'body';
      p.textContent = ${JSON.stringify(body)};
      content.appendChild(h);
      content.appendChild(p);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'close';
      btn.textContent = 'Скрыть';
      btn.addEventListener('click', () => {
        window.__goymusicScVerifyHintDismissed = true;
        host.remove();
      });
      card.appendChild(dot);
      card.appendChild(content);
      card.appendChild(btn);
      shadow.appendChild(style);
      shadow.appendChild(card);
      rootParent.appendChild(host);
    } catch {}
  })()`;
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

  let activeRefreshPromise: Promise<ScRefreshResult> | null = null;
  let cancelActiveRefresh: (() => void) | null = null;
  let activeSetTokensPromise: Promise<ScSetTokensResult> | null = null;
  let logoutInProgress = false;

  let verifyPromise: Promise<VerifyOutcome> | null = null;
  let cancelActiveVerify: (() => void) | null = null;

  function isCancelledEnvironment(): boolean {
    return disposed || deps.isShuttingDown() || logoutInProgress;
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

  async function readCookieValue(sess: TSession, name: string, previousValue?: string): Promise<string> {
    try {
      const list = await sess.cookies.get({ name });
      const scOnly = list.filter((c) => isSoundCloudCookieDomain(c.domain));
      return pickSoundCloudCookie(scOnly, previousValue)?.value || '';
    } catch {
      return '';
    }
  }

  async function removeCookiesByName(sess: TSession, name: string): Promise<void> {
    try {
      const list = await sess.cookies.get({ name });
      for (const cookie of list) {
        if (!isSoundCloudCookieDomain(cookie.domain)) continue;
        await sess.cookies.remove(buildCookieUrl(cookie), cookie.name);
      }
    } catch {
      // ignore
    }
  }

  async function dedupeSoundCloudCookie(
    sess: TSession,
    name: string,
    opts: { ttlDays: number; httpOnly?: boolean; sameSite?: 'lax' },
    previousValue?: string
  ): Promise<string> {
    try {
      const list = (await sess.cookies.get({ name })).filter((c) => isSoundCloudCookieDomain(c.domain));
      const winner = pickSoundCloudCookie(list, previousValue);
      if (list.length <= 1) return winner?.value || '';
      if (!winner || !winner.value) return '';
      // В Chromium cookies.remove(url, name) удаляет все куки, подходящие под url (и host-only, и .soundcloud.com),
      // поэтому безопасно удаляем все дубликаты и записываем обратно только победившую куку.
      await removeCookiesByName(sess, name);
      const expirationDate = Math.floor(Date.now() / 1000) + opts.ttlDays * 86_400;
      await sess.cookies.set({
        url: 'https://soundcloud.com',
        name,
        value: winner.value,
        path: '/',
        secure: true,
        expirationDate,
        ...(opts.httpOnly ? { httpOnly: true } : {}),
        ...(opts.sameSite ? { sameSite: opts.sameSite } : {}),
      });
      return winner.value;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.(`[soundcloud] dedupe ${name} failed: ${msg}`);
      return readCookieValue(sess, name, previousValue);
    }
  }

  async function setPersistentCookie(
    sess: TSession,
    name: string,
    value: string,
    opts: { ttlDays: number; httpOnly?: boolean; sameSite?: 'lax' }
  ): Promise<void> {
    // Сначала убираем возможные дубликаты на других доменах soundcloud.com, чтобы не было конфликта кук.
    const existing = (await sess.cookies.get({ name }).catch(() => [] as ScCookie[])).filter((c) =>
      isSoundCloudCookieDomain(c.domain)
    );
    const hasConflictingDomain = existing.some((c) => c.domain && c.domain !== 'soundcloud.com');
    if (hasConflictingDomain) {
      await removeCookiesByName(sess, name);
    }
    const expirationDate = Math.floor(Date.now() / 1000) + opts.ttlDays * 86_400;
    await sess.cookies.set({
      url: 'https://soundcloud.com',
      name,
      value,
      path: '/',
      secure: true,
      expirationDate,
      ...(opts.httpOnly ? { httpOnly: true } : {}),
      ...(opts.sameSite ? { sameSite: opts.sameSite } : {}),
    });
  }

  async function ensureOAuthCookie(sess: TSession, oauthToken: string): Promise<void> {
    const current = await readCookieValue(sess, 'oauth_token');
    if (current === oauthToken) return;
    // Не даем устаревшему JWT перезаписать более свежую куку в persist:soundcloud.
    if (isScJwtNewer(current, oauthToken)) return;
    await setPersistentCookie(sess, 'oauth_token', oauthToken, {
      ttlDays: OAUTH_TOKEN_TTL_DAYS,
      sameSite: 'lax',
    });
    await sess.cookies.flushStore();
  }

  async function removeStaleAuthCookies(sess: TSession): Promise<void> {
    // Сбрасываем только auth-куки, не трогая datadome, чтобы избежать тупика перелогина после 401 и не терять проверку DataDome.
    for (const name of AUTH_COOKIES_TO_CLEAR) {
      await removeCookiesByName(sess, name);
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
          title: getVerifyWindowTitle(ownerReq.liked),
          autoHideMenuBar: true,
          session: sess,
          userAgent: winUa,
        });
        verifyWin.webContents.setUserAgent(winUa);
        verifyWin.webContents.setAudioMuted(true);
        attachPopupHandling(verifyWin, sess, childWindows);
        const hintScript = buildVerifyHintScript(ownerReq.liked);
        const injectVerifyHint = () => {
          if (!verifyWin || verifyWin.isDestroyed()) return;
          verifyWin.webContents.executeJavaScript?.(hintScript)?.catch(() => {
            // Окно могло закрыться во время загрузки страницы.
          });
        };
        verifyWin.webContents.on('dom-ready', injectVerifyHint);
        verifyWin.webContents.on('did-finish-load', injectVerifyHint);
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
              const liveToken = (await readCookieValue(sess, 'oauth_token')) || ownerReq.oauthToken;
              const retry = await executeDirectLike(sess, { ...ownerReq, oauthToken: liveToken });
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
                const liveToken = (await readCookieValue(sess, 'oauth_token')) || ownerReq.oauthToken;
                const finalTry = await executeDirectLike(sess, { ...ownerReq, oauthToken: liveToken });
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

  type DirectOAuthRefreshOutcome =
    | { kind: 'ok'; accessToken: string; refreshToken: string }
    | { kind: 'unauthorized'; message: string }
    | { kind: 'error'; message: string };

  async function refreshViaDirectOAuth(
    sess: TSession,
    refreshToken: string,
    clientId: string,
    signal: AbortSignal
  ): Promise<DirectOAuthRefreshOutcome> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    });
    const resp = await sess.fetch(SC_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json; charset=utf-8',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://soundcloud.com',
        Referer: 'https://soundcloud.com/',
      },
      body: body.toString(),
      signal,
    });

    let bodyText = '';
    try {
      bodyText = await resp.text();
    } catch {
      bodyText = '';
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const json = JSON.parse(bodyText);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }

    if (resp.ok) {
      const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token.trim() : '';
      const nextRefresh = typeof parsed?.refresh_token === 'string' ? parsed.refresh_token.trim() : '';
      if (accessToken) {
        return { kind: 'ok', accessToken, refreshToken: nextRefresh };
      }
      return { kind: 'error', message: 'Missing access_token in OAuth refresh response' };
    }

    const oauthError = typeof parsed?.error === 'string' ? parsed.error : '';
    if (resp.status === 401 || (resp.status === 400 && oauthError === 'invalid_grant')) {
      return { kind: 'unauthorized', message: oauthError || `HTTP ${resp.status}` };
    }
    return { kind: 'error', message: oauthError || `HTTP ${resp.status}` };
  }

  // Однопоточный refresh oauth_token через SoundCloud Webi proxy (или прямой fallback secure.soundcloud.com).
  // Refresh-токены SoundCloud одноразовые, поэтому параллельные вызовы строго делят один in-flight промис.
  async function refresh(req?: ScRefreshRequest): Promise<ScRefreshResult> {
    const startLogoutGen = logoutGeneration;
    if (isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'App is shutting down' };
    }

    if (activeRefreshPromise) {
      const shared = await activeRefreshPromise;
      if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
        return { status: 'cancelled', message: 'Logged out' };
      }
      // Если force-вызов (после реального 401) присоединился к не-forced refresh, который вернул тот же токен,
      // не возвращаем протухший токен, а делаем принудительный refresh ниже.
      if (!(req?.force && shared.status === 'ok' && req.failedToken && shared.token === req.failedToken)) {
        return shared;
      }
    }

    const sess = getConfiguredSession();
    let cancelledExternally = false;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    cancelActiveRefresh = () => {
      cancelledExternally = true;
      controller.abort();
    };

    let promise: Promise<ScRefreshResult> | null = null;
    promise = (async (): Promise<ScRefreshResult> => {
      try {
        const currentCookie = await readCookieValue(sess, 'oauth_token');
        if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
          return { status: 'cancelled', message: 'Logged out' };
        }

        // Если другая вкладка/вызов уже ротировала oauth_token в persist:soundcloud, не сжигаем refresh_token повторно.
        if (
          req?.failedToken &&
          currentCookie &&
          currentCookie !== req.failedToken &&
          !isScTokenExpiringSoon(currentCookie, FRESH_COOKIE_LEEWAY_SEC)
        ) {
          return { status: 'ok', token: currentCookie };
        }
        if (
          !req?.force &&
          currentCookie &&
          !isScTokenExpiringSoon(currentCookie, PROACTIVE_REFRESH_LEEWAY_SEC)
        ) {
          return { status: 'ok', token: currentCookie };
        }

        // Без oauth_refresh_token НЕ вызываем /n/api/refresh-token: сервер SoundCloud в ответ присылает
        // Set-Cookie с очисткой oauth_token, что сломало бы валидный неистекающий токен.
        const refreshToken = await readCookieValue(sess, 'oauth_refresh_token');
        if (!refreshToken) {
          return { status: 'no_refresh_token' };
        }

        // Перед запросом убираем возможные старые дубликаты (.soundcloud.com + soundcloud.com),
        // чтобы в заголовке Cookie ушла ровно одна пара токенов и серверная очистка при 401 сработала чисто.
        const preRefreshOAuth =
          (await dedupeSoundCloudCookie(sess, 'oauth_token', {
            ttlDays: OAUTH_TOKEN_TTL_DAYS,
            sameSite: 'lax',
          })) || currentCookie;
        const preRefreshToken =
          (await dedupeSoundCloudCookie(sess, 'oauth_refresh_token', {
            ttlDays: REFRESH_TOKEN_TTL_DAYS,
            httpOnly: true,
            sameSite: 'lax',
          })) || refreshToken;

        if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
          return { status: 'cancelled', message: 'Logged out' };
        }

        // Прокси читает jwt.client_id из куки oauth_token, поэтому при ее отсутствии засеваем failedToken.
        if (!preRefreshOAuth && req?.failedToken) {
          await setPersistentCookie(sess, 'oauth_token', req.failedToken, {
            ttlDays: OAUTH_TOKEN_TTL_DAYS,
            sameSite: 'lax',
          });
        }

        timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);
        const resp = await sess.fetch(SC_REFRESH_PROXY_URL, {
          method: 'POST',
          headers: {
            Origin: 'https://soundcloud.com',
            Referer: 'https://soundcloud.com/',
            Accept: 'application/json, text/plain, */*',
          },
          credentials: 'include',
          signal: controller.signal,
        });

        if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
          return { status: 'cancelled', message: 'Logged out' };
        }

        if (resp.ok) {
          const nextToken = await dedupeSoundCloudCookie(
            sess,
            'oauth_token',
            { ttlDays: OAUTH_TOKEN_TTL_DAYS, sameSite: 'lax' },
            preRefreshOAuth || req?.failedToken
          );
          await dedupeSoundCloudCookie(
            sess,
            'oauth_refresh_token',
            { ttlDays: REFRESH_TOKEN_TTL_DAYS, httpOnly: true, sameSite: 'lax' },
            preRefreshToken
          );
          await sess.cookies.flushStore();
          if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
            return { status: 'cancelled', message: 'Logged out' };
          }
          const finalToken = nextToken || (await readCookieValue(sess, 'oauth_token', preRefreshOAuth || req?.failedToken));
          if (finalToken) {
            deps.log?.('[soundcloud] refreshed oauth_token via webi proxy');
            return { status: 'ok', token: finalToken };
          }
          return { status: 'error', message: 'Refresh response did not set oauth_token' };
        }

        const remainingRefresh = await readCookieValue(sess, 'oauth_refresh_token');
        if (!remainingRefresh || resp.status === 401) {
          try {
            await sess.cookies.flushStore();
          } catch {
            // ignore
          }
          deps.log?.(`[soundcloud] refresh rejected by webi proxy (HTTP ${resp.status})`);
          return { status: 'unauthorized', message: `HTTP ${resp.status}` };
        }

        // Безопасный fallback на прямой /oauth/token: только если прокси не успел сжечь одноразовый refresh_token
        // (403 DataDome или 404 при смене пути прокси) и кука oauth_refresh_token осталась на месте.
        if (resp.status === 403 || resp.status === 404) {
          const effectiveClientId =
            extractScJwtClientId(preRefreshOAuth || req?.failedToken || '') || req?.clientId || '';
          if (effectiveClientId) {
            const direct = await refreshViaDirectOAuth(
              sess,
              remainingRefresh,
              effectiveClientId,
              controller.signal
            );
            if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
              return { status: 'cancelled', message: 'Logged out' };
            }
            if (direct.kind === 'ok') {
              await setPersistentCookie(sess, 'oauth_token', direct.accessToken, {
                ttlDays: OAUTH_TOKEN_TTL_DAYS,
                sameSite: 'lax',
              });
              if (direct.refreshToken) {
                await setPersistentCookie(sess, 'oauth_refresh_token', direct.refreshToken, {
                  ttlDays: REFRESH_TOKEN_TTL_DAYS,
                  httpOnly: true,
                  sameSite: 'lax',
                });
              }
              await sess.cookies.flushStore();
              if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
                return { status: 'cancelled', message: 'Logged out' };
              }
              deps.log?.('[soundcloud] refreshed oauth_token via secure.soundcloud.com fallback');
              return { status: 'ok', token: direct.accessToken };
            }
            if (direct.kind === 'unauthorized') {
              await removeCookiesByName(sess, 'oauth_refresh_token');
              try {
                await sess.cookies.flushStore();
              } catch {
                // ignore
              }
              deps.log?.(`[soundcloud] direct refresh rejected (${direct.message})`);
              return { status: 'unauthorized', message: direct.message };
            }
            return { status: 'error', message: direct.message };
          }
        }

        return { status: 'error', message: `HTTP ${resp.status}` };
      } catch (err: unknown) {
        if (cancelledExternally || isCancelledEnvironment() || logoutGeneration !== startLogoutGen) {
          return { status: 'cancelled', message: 'Refresh cancelled' };
        }
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const message = isAbort
          ? 'Request timed out'
          : err instanceof Error
            ? err.message
            : String(err);
        return { status: 'error', message };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        cancelActiveRefresh = null;
        if (activeRefreshPromise === promise) {
          activeRefreshPromise = null;
        }
      }
    })();

    activeRefreshPromise = promise;
    return promise;
  }

  async function setTokens(req: ScSetTokensRequest): Promise<ScSetTokensResult> {
    const startLogoutGen = logoutGeneration;
    if (isCancelledEnvironment()) {
      return { status: 'error', message: 'App is shutting down' };
    }
    const oauthToken = (req?.oauthToken || '').trim();
    const refreshToken = (req?.refreshToken || '').trim();
    if (!oauthToken) {
      return { status: 'error', message: 'Missing oauth_token' };
    }

    let op: Promise<ScSetTokensResult> | null = null;
    op = (async (): Promise<ScSetTokensResult> => {
      if (activeRefreshPromise) {
        try {
          await activeRefreshPromise;
        } catch {
          // ignore
        }
      }
      if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
        return { status: 'error', message: 'Logged out' };
      }
      const sess = getConfiguredSession();
      try {
        const existingOAuth = await readCookieValue(sess, 'oauth_token');
        if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
          return { status: 'error', message: 'Logged out' };
        }
        await setPersistentCookie(sess, 'oauth_token', oauthToken, {
          ttlDays: OAUTH_TOKEN_TTL_DAYS,
          sameSite: 'lax',
        });
        if (refreshToken) {
          await setPersistentCookie(sess, 'oauth_refresh_token', refreshToken, {
            ttlDays: REFRESH_TOKEN_TTL_DAYS,
            httpOnly: true,
            sameSite: 'lax',
          });
        } else if (existingOAuth !== oauthToken) {
          // Пользователь вручную подключил другой токен (или кука oauth_token отсутствовала) без refresh_token:
          // убираем возможный старый oauth_refresh_token от прошлого аккаунта.
          await removeCookiesByName(sess, 'oauth_refresh_token');
        }
        await sess.cookies.flushStore();
        return { status: 'ok' };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'error', message };
      } finally {
        if (activeSetTokensPromise === op) {
          activeSetTokensPromise = null;
        }
      }
    })();

    activeSetTokensPromise = op;
    return op;
  }

  function withRefreshedToken<T extends Exclude<ScLikeResult, { status: 'cancelled' }>>(
    result: T,
    refreshedToken?: string
  ): T {
    return refreshedToken ? { ...result, refreshedToken } : result;
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
    let activeToken = req.oauthToken;
    let refreshedToken: string | undefined;
    let triedRefresh = Boolean(req.skipRefresh);

    // Если прямо сейчас идет refresh, дожидаемся его, чтобы не перезаписать свежую куку старым req.oauthToken.
    if (activeRefreshPromise) {
      const inFlightRef = await activeRefreshPromise;
      if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
        return { status: 'cancelled', message: 'Logged out' };
      }
      if (inFlightRef.status === 'ok' && inFlightRef.token && inFlightRef.token !== activeToken) {
        activeToken = inFlightRef.token;
        refreshedToken = inFlightRef.token;
        triedRefresh = true;
      }
    }

    const existingCookieToken = await readCookieValue(sess, 'oauth_token');
    if (
      existingCookieToken &&
      existingCookieToken !== activeToken &&
      (isScJwtNewer(existingCookieToken, activeToken) ||
        (isScTokenExpiringSoon(activeToken, PROACTIVE_REFRESH_LEEWAY_SEC) &&
          !isScTokenExpiringSoon(existingCookieToken, FRESH_COOKIE_LEEWAY_SEC)))
    ) {
      activeToken = existingCookieToken;
      refreshedToken = existingCookieToken;
    } else if (!triedRefresh && isScTokenExpiringSoon(activeToken, PROACTIVE_REFRESH_LEEWAY_SEC)) {
      triedRefresh = true;
      const ref = await refresh({ failedToken: activeToken, clientId: req.clientId });
      if (logoutGeneration !== startLogoutGen || isCancelledEnvironment() || ref.status === 'cancelled') {
        return { status: 'cancelled', message: 'Logged out' };
      }
      if (ref.status === 'ok') {
        activeToken = ref.token;
        refreshedToken = ref.token;
      } else if (ref.status === 'unauthorized' && isScTokenExpiringSoon(activeToken, 0)) {
        return { status: 'unauthorized', message: ref.message || 'HTTP 401' };
      }
    }

    if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'Logged out' };
    }

    try {
      await ensureOAuthCookie(sess, activeToken);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return withRefreshedToken(
        { status: 'error', message: `Failed to sync oauth_token cookie: ${message}` },
        refreshedToken
      );
    }

    if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'Logged out' };
    }

    let first = await executeDirectLike(sess, { ...req, oauthToken: activeToken });
    if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'Logged out' };
    }

    if (first.kind === 'done' && first.result.status === 'unauthorized' && !triedRefresh) {
      triedRefresh = true;
      const ref = await refresh({ failedToken: activeToken, clientId: req.clientId, force: true });
      if (logoutGeneration !== startLogoutGen || isCancelledEnvironment() || ref.status === 'cancelled') {
        return { status: 'cancelled', message: 'Logged out' };
      }
      if (ref.status === 'ok') {
        activeToken = ref.token;
        refreshedToken = ref.token;
        first = await executeDirectLike(sess, { ...req, oauthToken: activeToken });
        if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
          return { status: 'cancelled', message: 'Logged out' };
        }
      }
    }

    if (first.kind === 'done') {
      if (first.result.status === 'cancelled') {
        return first.result;
      }
      return withRefreshedToken(first.result, refreshedToken);
    }

    const activeReq: ScLikeRequest = { ...req, oauthToken: activeToken };

    // Single-flight мьютекс: параллельные 403 DataDome разделяют одно окно проверки.
    let isOwner = false;
    let activeVerify = verifyPromise;
    if (!activeVerify) {
      isOwner = true;
      activeVerify = runVerificationModal(sess, activeReq);
      verifyPromise = activeVerify;
    }

    const outcome = await activeVerify;
    if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'Logged out' };
    }
    const likedLabel: 'liked' | 'unliked' = req.liked ? 'liked' : 'unliked';

    const postModalToken = await readCookieValue(sess, 'oauth_token');
    if (postModalToken && postModalToken !== activeToken) {
      activeToken = postModalToken;
      refreshedToken = postModalToken;
    }

    if (outcome.status === 'cancelled') {
      return { status: 'cancelled', message: outcome.message };
    }
    if (outcome.status === 'unauthorized') {
      return withRefreshedToken({ status: 'unauthorized', message: outcome.message }, refreshedToken);
    }
    if (outcome.status === 'error') {
      return withRefreshedToken({ status: 'error', message: outcome.message }, refreshedToken);
    }

    if (isOwner && outcome.ownerCompleted) {
      return withRefreshedToken({ status: 'ok', liked: likedLabel, verified: true }, refreshedToken);
    }

    const retry = await executeDirectLike(sess, { ...req, oauthToken: activeToken });
    if (logoutGeneration !== startLogoutGen || isCancelledEnvironment()) {
      return { status: 'cancelled', message: 'Logged out' };
    }
    if (retry.kind === 'done') {
      if (retry.result.status === 'ok') {
        return withRefreshedToken({ ...retry.result, verified: true }, refreshedToken);
      }
      if (retry.result.status === 'cancelled') {
        return retry.result;
      }
      return withRefreshedToken(retry.result, refreshedToken);
    }

    return withRefreshedToken({ status: 'error', message: 'DataDome verification required' }, refreshedToken);
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
              let settleAttempts = 0;
              const finalizeCapture = () => {
                if (cancelledExternally || isCancelledEnvironment()) {
                  finish({ status: 'cancelled' });
                  return;
                }
                void (async () => {
                  const latest = (await readCookieValue(sess, 'oauth_token')) || tok;
                  const refreshTok = await readCookieValue(sess, 'oauth_refresh_token');
                  if (cancelledExternally || isCancelledEnvironment()) {
                    finish({ status: 'cancelled' });
                    return;
                  }
                  const isJwt = typeof parseScJwt(latest)?.exp === 'number';
                  // Для истекающего JWT даем куке oauth_refresh_token немного времени на фиксацию, если она еще не записалась.
                  if (isJwt && !refreshTok && settleAttempts < 3) {
                    settleAttempts += 1;
                    settleTimer = setTimeout(finalizeCapture, loginSettleDelayMs);
                    return;
                  }
                  deps.log?.(
                    `[soundcloud] login ok (jwt=${isJwt}, hasRefreshToken=${Boolean(refreshTok)})`
                  );
                  finish({ status: 'ok', token: latest });
                })();
              };
              settleTimer = setTimeout(finalizeCapture, loginSettleDelayMs);
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
    logoutInProgress = true;
    try {
      const pendingLogin = activeLoginPromise;
      const pendingVerify = verifyPromise;
      const pendingRefresh = activeRefreshPromise;
      const pendingSetTokens = activeSetTokensPromise;

      cancelActiveLogin?.();
      cancelActiveVerify?.();
      cancelActiveRefresh?.();

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
      if (pendingRefresh) {
        try {
          await pendingRefresh;
        } catch {
          // ignore
        }
      }
      if (pendingSetTokens) {
        try {
          await pendingSetTokens;
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
    } finally {
      logoutInProgress = false;
    }
  }

  function dispose(): void {
    disposed = true;
    cancelActiveLogin?.();
    cancelActiveVerify?.();
    cancelActiveRefresh?.();
  }

  return {
    login,
    logout,
    like,
    refresh,
    setTokens,
    dispose,
  };
}
