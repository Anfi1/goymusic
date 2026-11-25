import { describe, expect, it, vi } from 'vitest';
import {
  computeCenteredBounds,
  createScLikesController,
  isDataDomeChallenge,
  type Rect,
  type ScCookie,
  type ScFetchResponse,
  type ScLikeRequest,
  type ScSessionLike,
  type ScWindowLike,
  type ScWindowOptions,
} from '../../electron/scLikes';

type BeforeSendListener = (
  details: { url: string; requestHeaders: Record<string, string> },
  callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void
) => void;

type BeforeRequestListener = (
  details: { url: string },
  callback: (response: { cancel?: boolean }) => void
) => void;

type CompletedListener = (details: { url: string; method: string; statusCode: number }) => void;

interface MockWindow extends ScWindowLike {
  options: ScWindowOptions;
  loadedUrls: string[];
  userAgents: string[];
  mutedValues: boolean[];
  shownCount: number;
  destroyed: boolean;
  windowOpenHandler:
    | ((details: { url: string }) => { action: 'allow' | 'deny'; overrideBrowserWindowOptions?: Record<string, unknown> })
    | null;
  emitClosed: () => void;
  emitChildWindow: (child: MockWindow) => void;
}

function createMockWindow(options: ScWindowOptions): MockWindow {
  const closedListeners = new Set<() => void>();
  const childListeners = new Set<(child: ScWindowLike) => void>();

  const win: MockWindow = {
    options,
    loadedUrls: [],
    userAgents: [],
    mutedValues: [],
    shownCount: 0,
    destroyed: false,
    windowOpenHandler: null,
    isDestroyed: () => win.destroyed,
    destroy: () => {
      if (win.destroyed) return;
      win.destroyed = true;
      win.emitClosed();
    },
    show: () => {
      win.shownCount += 1;
    },
    moveTop: () => {},
    focus: () => {},
    loadURL: async (url: string) => {
      win.loadedUrls.push(url);
    },
    once: (_event: 'closed', listener: () => void) => {
      closedListeners.add(listener);
    },
    removeListener: (_event: 'closed', listener: () => void) => {
      closedListeners.delete(listener);
    },
    webContents: {
      setUserAgent: (ua: string) => {
        win.userAgents.push(ua);
      },
      setAudioMuted: (muted: boolean) => {
        win.mutedValues.push(muted);
      },
      setWindowOpenHandler: (handler) => {
        win.windowOpenHandler = handler as MockWindow['windowOpenHandler'];
      },
      on: (_event: 'did-create-window', listener: (child: ScWindowLike) => void) => {
        childListeners.add(listener);
      },
    },
    emitClosed: () => {
      const list = Array.from(closedListeners);
      closedListeners.clear();
      for (const fn of list) fn();
    },
    emitChildWindow: (child: MockWindow) => {
      for (const fn of childListeners) fn(child);
    },
  };

  return win;
}

function createMockResponse(
  status: number,
  body = '',
  headers: Record<string, string> = {}
): ScFetchResponse {
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    normalized.set(k.toLowerCase(), v);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
    },
    text: async () => body,
  };
}

interface HarnessOptions {
  initialCookies?: ScCookie[];
  mainBounds?: Rect | null;
  workArea?: Rect;
  chromeVersion?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<ScFetchResponse>;
}

function createHarness(opts: HarnessOptions = {}) {
  const cookies: ScCookie[] = [...(opts.initialCookies ?? [])];
  const createdWindows: MockWindow[] = [];
  const removedCookies: Array<{ url: string; name: string }> = [];
  const setCookieCalls: Array<{ url: string; name: string; value: string }> = [];
  const clearStorageCalls: Array<{ storages?: string[] } | undefined> = [];
  const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
  let flushCount = 0;
  let sessionUserAgent = '';
  let shuttingDown = false;

  let beforeSendListener: BeforeSendListener | null = null;
  let beforeRequestListener: BeforeRequestListener | null = null;
  let completedListener: CompletedListener | null = null;

  const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<ScFetchResponse> => {
    fetchCalls.push({ input, init });
    if (opts.fetchImpl) {
      return opts.fetchImpl(input, init);
    }
    return createMockResponse(200, '{}');
  });

  const sess: ScSessionLike = {
    setUserAgent: (ua: string) => {
      sessionUserAgent = ua;
    },
    fetch: fetchMock,
    cookies: {
      get: async (filter) => {
        return cookies.filter((c) => {
          if (filter.name && c.name !== filter.name) return false;
          if (filter.domain && c.domain !== filter.domain) return false;
          return true;
        });
      },
      set: async (details) => {
        setCookieCalls.push({ url: details.url, name: details.name, value: details.value });
        const idx = cookies.findIndex((c) => c.name === details.name);
        const next: ScCookie = {
          name: details.name,
          value: details.value,
          domain: '.soundcloud.com',
          path: details.path ?? '/',
        };
        if (idx >= 0) cookies[idx] = next;
        else cookies.push(next);
      },
      remove: async (url, name) => {
        removedCookies.push({ url, name });
        for (let i = cookies.length - 1; i >= 0; i -= 1) {
          if (cookies[i].name === name) cookies.splice(i, 1);
        }
      },
      flushStore: async () => {
        flushCount += 1;
      },
    },
    clearStorageData: async (options) => {
      clearStorageCalls.push(options);
      if (!options) {
        cookies.length = 0;
      }
    },
    webRequest: {
      onBeforeSendHeaders: (listener) => {
        beforeSendListener = listener;
      },
      onBeforeRequest: (listener) => {
        beforeRequestListener = listener;
      },
      onCompleted: (_filter, listener) => {
        completedListener = listener;
      },
    },
  };

  const workArea: Rect = opts.workArea ?? { x: 0, y: 0, width: 1920, height: 1040 };
  const mainBounds: Rect | null =
    opts.mainBounds === undefined ? { x: 200, y: 120, width: 1200, height: 800 } : opts.mainBounds;

  const controller = createScLikesController({
    getSession: () => sess,
    createWindow: (winOpts) => {
      const w = createMockWindow(winOpts);
      createdWindows.push(w);
      return w;
    },
    getMainBounds: () => mainBounds,
    getWorkAreaForBounds: () => workArea,
    isShuttingDown: () => shuttingDown,
    chromeVersion: opts.chromeVersion ?? '138.0.7204.50',
    fetchTimeoutMs: 500,
    verifyTimeoutMs: 2000,
    verifyPollIntervalMs: 15,
    verifySettleDelayMs: 15,
    loginPollIntervalMs: 15,
    loginSettleDelayMs: 15,
  });

  function checkBeforeRequestBlocked(url: string): boolean {
    if (!beforeRequestListener) return false;
    let cancelled = false;
    beforeRequestListener({ url }, (res) => {
      cancelled = Boolean(res.cancel);
    });
    return cancelled;
  }

  function runBeforeSendHeaders(url: string): Record<string, string | string[]> {
    const reqHeaders: Record<string, string> = {};
    let out: Record<string, string | string[]> = reqHeaders;
    if (beforeSendListener) {
      beforeSendListener({ url, requestHeaders: reqHeaders }, (res) => {
        if (res.requestHeaders) out = res.requestHeaders;
      });
    }
    return out;
  }

  function emitCompleted(details: { url: string; method: string; statusCode: number }) {
    completedListener?.(details);
  }

  function setCookieDirect(cookie: ScCookie) {
    const idx = cookies.findIndex((c) => c.name === cookie.name);
    if (idx >= 0) cookies[idx] = cookie;
    else cookies.push(cookie);
  }

  return {
    controller,
    sess,
    cookies,
    createdWindows,
    removedCookies,
    setCookieCalls,
    clearStorageCalls,
    fetchCalls,
    fetchMock,
    getFlushCount: () => flushCount,
    getSessionUserAgent: () => sessionUserAgent,
    setShuttingDown: (val: boolean) => {
      shuttingDown = val;
    },
    checkBeforeRequestBlocked,
    runBeforeSendHeaders,
    emitCompleted,
    setCookieDirect,
  };
}

function makeLikeRequest(overrides: Partial<ScLikeRequest> = {}): ScLikeRequest {
  return {
    uid: '998877',
    scId: '123456789',
    scUrl: 'https://soundcloud.com/artist/track-name',
    liked: true,
    oauthToken: 'tok-abc-123',
    clientId: 'cid-xyz',
    appVersion: '1700000000',
    ...overrides,
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('computeCenteredBounds', () => {
  it('centers window over mainBounds inside workArea', () => {
    const bounds = computeCenteredBounds(
      { x: 200, y: 100, width: 1200, height: 800 },
      { x: 0, y: 0, width: 1920, height: 1040 },
      960,
      760
    );
    expect(bounds).toEqual({ x: 320, y: 120, width: 960, height: 760 });
  });

  it('clamps inside workArea including negative multi-monitor coordinates', () => {
    const leftMonitor: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
    const centered = computeCenteredBounds(
      { x: -1800, y: 100, width: 1200, height: 800 },
      leftMonitor,
      960,
      760
    );
    expect(centered).toEqual({ x: -1680, y: 120, width: 960, height: 760 });

    const clampedLeft = computeCenteredBounds(
      { x: -2200, y: -100, width: 1000, height: 700 },
      leftMonitor,
      960,
      760
    );
    expect(clampedLeft).toEqual({ x: -1920, y: 0, width: 960, height: 760 });

    const clampedRight = computeCenteredBounds(
      { x: -200, y: 600, width: 1000, height: 700 },
      leftMonitor,
      960,
      760
    );
    expect(clampedRight).toEqual({ x: -960, y: 280, width: 960, height: 760 });
  });

  it('falls back to workArea when mainBounds is null and shrinks if larger than workArea', () => {
    const fallback = computeCenteredBounds(null, { x: 0, y: 0, width: 1920, height: 1040 }, 980, 760);
    expect(fallback).toEqual({ x: 470, y: 140, width: 980, height: 760 });

    const shrunk = computeCenteredBounds(null, { x: 10, y: 20, width: 800, height: 600 }, 980, 760);
    expect(shrunk).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });
});

describe('isDataDomeChallenge', () => {
  it('detects 403 responses with DataDome headers or challenge body', () => {
    expect(isDataDomeChallenge(403, { 'x-datadome': 'protected' }, '')).toBe(true);
    expect(isDataDomeChallenge(403, { 'X-DataDome': 'protected' }, '')).toBe(true);
    expect(isDataDomeChallenge(403, { 'x-dd-b': '1' }, '')).toBe(true);
    expect(
      isDataDomeChallenge(403, {}, '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=1"}')
    ).toBe(true);
    expect(isDataDomeChallenge(403, {}, 'Blocked by DataDome')).toBe(true);
  });

  it('returns false for non-403 statuses or generic 403 responses', () => {
    expect(isDataDomeChallenge(200, { 'x-datadome': 'protected' }, '')).toBe(false);
    expect(isDataDomeChallenge(401, { 'x-dd-b': '1' }, 'datadome')).toBe(false);
    expect(isDataDomeChallenge(403, {}, '{}')).toBe(false);
    expect(isDataDomeChallenge(403, { 'x-datadome': undefined }, 'Forbidden')).toBe(false);
  });
});

describe('createScLikesController', () => {
  it('seeds oauth_token without removing datadome and executes PUT/DELETE via sess.fetch with 0 windows', async () => {
    const h = createHarness({
      initialCookies: [{ name: 'datadome', value: 'dd-existing', domain: '.soundcloud.com' }],
    });

    const putRes = await h.controller.like(makeLikeRequest({ liked: true }));
    expect(putRes).toEqual({ status: 'ok', liked: 'liked', verified: false });
    expect(h.createdWindows).toHaveLength(0);

    // oauth_token was seeded while datadome stayed untouched
    expect(h.cookies.find((c) => c.name === 'datadome')?.value).toBe('dd-existing');
    expect(h.cookies.find((c) => c.name === 'oauth_token')?.value).toBe('tok-abc-123');
    expect(h.removedCookies).toHaveLength(0);
    expect(h.getFlushCount()).toBe(1);

    // Session UA and client hints match Chrome version without Electron token
    expect(h.getSessionUserAgent()).toContain('Chrome/138.0.7204.50');
    expect(h.getSessionUserAgent()).not.toContain('Electron');
    const hdrs = h.runBeforeSendHeaders('https://api-v2.soundcloud.com/test');
    expect(hdrs['User-Agent']).toBe(h.getSessionUserAgent());
    expect(hdrs['sec-ch-ua']).toContain('v="138"');

    // Verify PUT fetch request shape
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].input).toBe(
      'https://api-v2.soundcloud.com/users/998877/track_likes/123456789?client_id=cid-xyz&app_version=1700000000&app_locale=en'
    );
    expect(h.fetchCalls[0].init?.method).toBe('PUT');
    expect(h.fetchCalls[0].init?.credentials).toBe('include');
    expect(h.fetchCalls[0].init?.headers).toEqual({
      Authorization: 'OAuth tok-abc-123',
      Origin: 'https://soundcloud.com',
      Referer: 'https://soundcloud.com/',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    });

    // Second call with same token does not rewrite cookie and uses DELETE for unlike
    const delRes = await h.controller.like(makeLikeRequest({ liked: false }));
    expect(delRes).toEqual({ status: 'ok', liked: 'unliked', verified: false });
    expect(h.fetchCalls[1].init?.method).toBe('DELETE');
    expect(h.setCookieCalls).toHaveLength(1);
    expect(h.createdWindows).toHaveLength(0);
  });

  it('treats DELETE HTTP 404 as ok unliked without opening windows', async () => {
    const h = createHarness({
      fetchImpl: async () => createMockResponse(404, '{"errors":[]}'),
    });

    const res = await h.controller.like(makeLikeRequest({ liked: false }));
    expect(res).toEqual({ status: 'ok', liked: 'unliked', verified: false });
    expect(h.createdWindows).toHaveLength(0);
  });

  it('returns unauthorized on HTTP 401 without opening any window', async () => {
    const h = createHarness({
      fetchImpl: async () => createMockResponse(401, 'Unauthorized'),
    });

    const res = await h.controller.like(makeLikeRequest({ liked: true }));
    expect(res).toEqual({ status: 'unauthorized', message: 'HTTP 401' });
    expect(h.createdWindows).toHaveLength(0);
  });

  it('uses single-flight verification modal on concurrent 403 DataDome and retries queued calls', async () => {
    let verified = false;
    const h = createHarness({
      initialCookies: [
        { name: 'oauth_token', value: 'tok-abc-123', domain: '.soundcloud.com' },
        { name: 'datadome', value: 'dd-stale', domain: '.soundcloud.com' },
      ],
      fetchImpl: async () => {
        if (!verified) {
          return createMockResponse(403, '{"url":"https://geo.captcha-delivery.com/captcha/"}', {
            'x-datadome': 'protected',
          });
        }
        return createMockResponse(200, 'true');
      },
    });

    const reqA = makeLikeRequest({
      scId: '111',
      scUrl: 'https://soundcloud.com/artist/track-a',
      liked: true,
    });
    const reqB = makeLikeRequest({
      scId: '222',
      scUrl: 'https://soundcloud.com/artist/track-b',
      liked: true,
    });

    const promiseA = h.controller.like(reqA);
    const promiseB = h.controller.like(reqB);

    await waitForCondition(() => h.createdWindows.length === 1);
    const verifyWin = h.createdWindows[0];

    // Exactly ONE modal centered over mainBounds (960x760), muted, clean UA, popup handler
    expect(h.createdWindows).toHaveLength(1);
    expect(verifyWin.options.width).toBe(960);
    expect(verifyWin.options.height).toBe(760);
    expect(verifyWin.options.x).toBe(320);
    expect(verifyWin.options.y).toBe(140);
    expect(verifyWin.options.autoHideMenuBar).toBe(true);
    expect(verifyWin.mutedValues).toEqual([true]);
    expect(verifyWin.userAgents[0]).toContain('Chrome/138.0.7204.50');
    expect(verifyWin.loadedUrls).toEqual(['https://soundcloud.com/artist/track-a']);
    expect(verifyWin.windowOpenHandler).not.toBeNull();

    // Logout guard is active during verification modal
    expect(h.checkBeforeRequestBlocked('https://soundcloud.com/logout')).toBe(true);
    expect(h.checkBeforeRequestBlocked('https://soundcloud.com/signout')).toBe(true);
    expect(h.checkBeforeRequestBlocked('https://api-auth.soundcloud.com/oauth2/revoke')).toBe(true);
    expect(h.checkBeforeRequestBlocked('https://soundcloud.com/artist/track-a')).toBe(false);

    // Simulate user completing track like inside verification window
    verified = true;
    h.setCookieDirect({ name: 'datadome', value: 'dd-fresh', domain: '.soundcloud.com' });
    h.emitCompleted({
      url: 'https://api-v2.soundcloud.com/users/998877/track_likes/111?client_id=cid-xyz',
      method: 'PUT',
      statusCode: 200,
    });

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(resA).toEqual({ status: 'ok', liked: 'liked', verified: true });
    expect(resB).toEqual({ status: 'ok', liked: 'liked', verified: true });

    // Still only ONE verification window created across both concurrent 403s
    expect(h.createdWindows).toHaveLength(1);
    expect(verifyWin.destroyed).toBe(true);
    expect(h.getFlushCount()).toBeGreaterThanOrEqual(1);

    // Logout guard disabled after teardown
    expect(h.checkBeforeRequestBlocked('https://soundcloud.com/logout')).toBe(false);

    // Only serviceworkers cleared, cookies preserved
    expect(h.clearStorageCalls).toEqual([{ storages: ['serviceworkers'] }]);
    expect(h.cookies.find((c) => c.name === 'datadome')?.value).toBe('dd-fresh');

    // Queued call B retried sess.fetch automatically after verification completed
    const bCalls = h.fetchCalls.filter((c) => c.input.includes('/track_likes/222'));
    expect(bCalls).toHaveLength(2);
  });

  it('completes verification via datadome cookie change + follow-up sess.fetch retry', async () => {
    let datadomeValid = false;
    const h = createHarness({
      initialCookies: [
        { name: 'oauth_token', value: 'tok-abc-123', domain: '.soundcloud.com' },
        { name: 'datadome', value: 'dd-old', domain: '.soundcloud.com' },
      ],
      fetchImpl: async () => {
        if (!datadomeValid) {
          return createMockResponse(403, 'datadome', { 'x-dd-b': '1' });
        }
        return createMockResponse(200, 'true');
      },
    });

    const promise = h.controller.like(makeLikeRequest({ scId: '555', scUrl: 'invalid-url' }));
    await waitForCondition(() => h.createdWindows.length === 1);

    // Fallback URL when scUrl is not https://soundcloud.com/...
    expect(h.createdWindows[0].loadedUrls).toEqual(['https://soundcloud.com/tracks/555']);

    // Cookie updates without clicking Like in DOM -> poll retries sess.fetch and succeeds
    datadomeValid = true;
    h.setCookieDirect({ name: 'datadome', value: 'dd-new', domain: '.soundcloud.com' });

    const res = await promise;
    expect(res).toEqual({ status: 'ok', liked: 'liked', verified: true });
    expect(h.createdWindows[0].destroyed).toBe(true);
    expect(h.clearStorageCalls).toEqual([{ storages: ['serviceworkers'] }]);
  });

  it('login removes stale auth cookies while preserving datadome, handles OAuth popups, and cleans up', async () => {
    const h = createHarness({
      initialCookies: [
        { name: 'oauth_token', value: 'stale-token', domain: '.soundcloud.com', path: '/' },
        { name: 'oauth_refresh_token', value: 'stale-refresh', domain: '.soundcloud.com', path: '/' },
        { name: 'sc_session', value: 'stale-sess', domain: '.soundcloud.com', path: '/' },
        { name: 'datadome', value: 'dd-keep-me', domain: '.soundcloud.com', path: '/' },
      ],
    });

    const loginPromise = h.controller.login();
    await waitForCondition(() => h.createdWindows.length === 1);

    // Stale auth cookies removed before opening window, datadome preserved
    expect(h.removedCookies.map((r) => r.name).sort()).toEqual([
      'oauth_refresh_token',
      'oauth_token',
      'sc_session',
    ]);
    expect(h.cookies.find((c) => c.name === 'datadome')?.value).toBe('dd-keep-me');
    expect(h.cookies.find((c) => c.name === 'oauth_token')).toBeUndefined();

    const loginWin = h.createdWindows[0];
    expect(loginWin.options.width).toBe(980);
    expect(loginWin.options.height).toBe(760);
    expect(loginWin.loadedUrls).toEqual(['https://soundcloud.com/signin']);

    // OAuth popup support via setWindowOpenHandler + child window tracking
    expect(loginWin.windowOpenHandler).not.toBeNull();
    const popupDecision = loginWin.windowOpenHandler!({ url: 'https://accounts.google.com/o/oauth2/v2/auth' });
    expect(popupDecision.action).toBe('allow');
    expect((popupDecision.overrideBrowserWindowOptions as any)?.webPreferences?.session).toBe(h.sess);

    const childPopup = createMockWindow({
      x: 0,
      y: 0,
      width: 560,
      height: 680,
      show: true,
      title: 'Google',
      autoHideMenuBar: true,
      session: h.sess,
      userAgent: h.getSessionUserAgent(),
    });
    loginWin.emitChildWindow(childPopup);
    expect(childPopup.userAgents[0]).toContain('Chrome/138.0.7204.50');

    // Simulate user completing login -> new oauth_token appears
    h.setCookieDirect({ name: 'oauth_token', value: 'fresh-oauth-token', domain: '.soundcloud.com' });

    const res = await loginPromise;
    expect(res).toEqual({ status: 'ok', token: 'fresh-oauth-token' });
    expect(h.getFlushCount()).toBeGreaterThanOrEqual(1);
    expect(loginWin.destroyed).toBe(true);
    expect(childPopup.destroyed).toBe(true);
    expect(h.clearStorageCalls).toEqual([{ storages: ['serviceworkers'] }]);
    expect(h.cookies.find((c) => c.name === 'datadome')?.value).toBe('dd-keep-me');
  });

  it('logout destroys open windows, cancels pending login, and clears all session storage', async () => {
    const h = createHarness({
      initialCookies: [
        { name: 'oauth_token', value: 'tok', domain: '.soundcloud.com' },
        { name: 'datadome', value: 'dd', domain: '.soundcloud.com' },
      ],
    });

    const loginPromise = h.controller.login();
    await waitForCondition(() => h.createdWindows.length === 1);
    const loginWin = h.createdWindows[0];

    const logoutRes = await h.controller.logout();
    const loginRes = await loginPromise;

    expect(logoutRes).toEqual({ status: 'ok' });
    expect(loginRes).toEqual({ status: 'cancelled' });
    expect(loginWin.destroyed).toBe(true);
    expect(h.clearStorageCalls.some((arg) => arg === undefined)).toBe(true);
    expect(h.cookies).toHaveLength(0);
  });

  it('dispose destroys open windows and settles active login and verify promises as cancelled', async () => {
    // 1. Dispose during active login
    const h1 = createHarness();
    const loginPromise = h1.controller.login();
    await waitForCondition(() => h1.createdWindows.length === 1);

    h1.controller.dispose();
    const loginRes = await loginPromise;
    expect(loginRes).toEqual({ status: 'cancelled' });
    expect(h1.createdWindows[0].destroyed).toBe(true);

    // 2. Dispose during active verification modal
    const h2 = createHarness({
      initialCookies: [{ name: 'oauth_token', value: 'tok-abc-123', domain: '.soundcloud.com' }],
      fetchImpl: async () => createMockResponse(403, 'datadome', { 'x-datadome': 'protected' }),
    });
    const likePromise = h2.controller.like(makeLikeRequest());
    await waitForCondition(() => h2.createdWindows.length === 1);

    h2.controller.dispose();
    const likeRes = await likePromise;
    expect(likeRes.status).toBe('cancelled');
    expect(h2.createdWindows[0].destroyed).toBe(true);
  });

  it('returns cancelled and cleans up when user closes verification or login window manually', async () => {
    const hVerify = createHarness({
      initialCookies: [
        { name: 'oauth_token', value: 'tok-abc-123', domain: '.soundcloud.com' },
        { name: 'datadome', value: 'dd-old', domain: '.soundcloud.com' },
      ],
      fetchImpl: async () => createMockResponse(403, 'datadome', { 'x-datadome': 'protected' }),
    });

    const likePromise = hVerify.controller.like(makeLikeRequest());
    await waitForCondition(() => hVerify.createdWindows.length === 1);
    expect(hVerify.checkBeforeRequestBlocked('https://soundcloud.com/logout')).toBe(true);

    hVerify.createdWindows[0].emitClosed();
    const likeRes = await likePromise;
    expect(likeRes).toEqual({ status: 'cancelled', message: 'Verification cancelled' });
    expect(hVerify.checkBeforeRequestBlocked('https://soundcloud.com/logout')).toBe(false);
    expect(hVerify.clearStorageCalls).toEqual([{ storages: ['serviceworkers'] }]);

    const hLogin = createHarness();
    const loginPromise = hLogin.controller.login();
    await waitForCondition(() => hLogin.createdWindows.length === 1);

    hLogin.createdWindows[0].emitClosed();
    const loginRes = await loginPromise;
    expect(loginRes).toEqual({ status: 'cancelled' });
    expect(hLogin.clearStorageCalls).toEqual([{ storages: ['serviceworkers'] }]);
  });
});
