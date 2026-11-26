// Единый leeway для проактивного обновления JWT в main и renderer (должны совпадать, чтобы таймер не попадал в мертвую зону).
export const SC_PROACTIVE_REFRESH_LEEWAY_SEC = 180;
const SC_TIMER_JITTER_CUSHION_MS = 1_500;

export interface ScJwtClaims {
  exp?: number;
  clientId?: string;
}

function decodeBase64Url(segment: string): string | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    if (typeof atob === 'function') {
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }
  } catch {
    return null;
  }
  return null;
}

// Разбирает JWT oauth_token SoundCloud (новый формат с exp/client_id). Для legacy-токенов (2-...) возвращает null.
export function parseScJwt(token: string | null | undefined): ScJwtClaims | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const payloadStr = decodeBase64Url(parts[1]);
  if (!payloadStr) return null;
  try {
    const parsed = JSON.parse(payloadStr) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const exp =
      typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp : undefined;
    const clientId =
      typeof parsed.client_id === 'string' && parsed.client_id.trim()
        ? parsed.client_id.trim()
        : undefined;
    return { exp, clientId };
  } catch {
    return null;
  }
}

// Возвращает true только для JWT с exp, истекающего в пределах leewaySeconds. Для non-JWT всегда false.
export function isScTokenExpiringSoon(
  token: string | null | undefined,
  leewaySeconds = SC_PROACTIVE_REFRESH_LEEWAY_SEC,
  nowMs = Date.now()
): boolean {
  const claims = parseScJwt(token);
  if (!claims || typeof claims.exp !== 'number') return false;
  return nowMs / 1000 >= claims.exp - leewaySeconds;
}

// Возвращает true, если candidate - JWT с более поздним exp, чем current (защита от перезаписи свежей куки старым токеном).
export function isScJwtNewer(
  candidate: string | null | undefined,
  current: string | null | undefined
): boolean {
  const candExp = parseScJwt(candidate)?.exp;
  const currExp = parseScJwt(current)?.exp;
  return typeof candExp === 'number' && typeof currExp === 'number' && candExp > currExp;
}

// Вытаскивает client_id из JWT-пейлоада (SoundCloud Webi использует именно его для refresh_token).
export function extractScJwtClientId(token: string | null | undefined): string {
  return parseScJwt(token)?.clientId || '';
}

// Время до проактивного обновления JWT в мс (null для non-JWT, 0 если уже пора обновлять).
// Небольшой запас SC_TIMER_JITTER_CUSHION_MS гарантирует, что срабатывание таймера попадет строго внутрь окна leewaySeconds.
export function getScTokenRefreshDelayMs(
  token: string | null | undefined,
  leewaySeconds = SC_PROACTIVE_REFRESH_LEEWAY_SEC,
  nowMs = Date.now()
): number | null {
  const claims = parseScJwt(token);
  if (!claims || typeof claims.exp !== 'number') return null;
  const remainingMs = (claims.exp - leewaySeconds) * 1000 - nowMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs) + SC_TIMER_JITTER_CUSHION_MS;
}
