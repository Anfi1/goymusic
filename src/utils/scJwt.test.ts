import { describe, expect, it } from 'vitest';
import {
  extractScJwtClientId,
  getScTokenRefreshDelayMs,
  isScJwtNewer,
  isScTokenExpiringSoon,
  parseScJwt,
  SC_PROACTIVE_REFRESH_LEEWAY_SEC,
} from './scJwt';

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig_part`;
}

describe('scJwt utilities', () => {
  it('парсит exp и client_id из JWT oauth_token', () => {
    const token = makeJwt({ exp: 1_900_000_000, client_id: 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k' });
    expect(parseScJwt(token)).toEqual({
      exp: 1_900_000_000,
      clientId: 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k',
    });
    expect(extractScJwtClientId(token)).toBe('QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k');
  });

  it('возвращает null и false для legacy opaque-токенов и битых строк', () => {
    expect(parseScJwt('2-298123-123456789-abcdef')).toBeNull();
    expect(parseScJwt('')).toBeNull();
    expect(parseScJwt('not.a.jwt')).toBeNull();
    expect(isScTokenExpiringSoon('2-298123-123456789-abcdef')).toBe(false);
    expect(extractScJwtClientId('2-298123-123456789-abcdef')).toBe('');
    expect(getScTokenRefreshDelayMs('2-298123-123456789-abcdef')).toBeNull();
  });

  it('определяет скорое истечение JWT с учетом leewaySeconds', () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = nowMs / 1000;
    const fresh = makeJwt({ exp: nowSec + 600 });
    const expiringSoon = makeJwt({ exp: nowSec + 90 });
    const expired = makeJwt({ exp: nowSec - 10 });

    expect(isScTokenExpiringSoon(fresh, 120, nowMs)).toBe(false);
    expect(isScTokenExpiringSoon(expiringSoon, 120, nowMs)).toBe(true);
    expect(isScTokenExpiringSoon(expired, 120, nowMs)).toBe(true);

    expect(getScTokenRefreshDelayMs(fresh, 180, nowMs)).toBe(421_500);
    expect(getScTokenRefreshDelayMs(expiringSoon, 180, nowMs)).toBe(0);

    // При срабатывании таймера на границе SC_PROACTIVE_REFRESH_LEEWAY_SEC токен строго попадает в окно обновления.
    const delay = getScTokenRefreshDelayMs(fresh, SC_PROACTIVE_REFRESH_LEEWAY_SEC, nowMs)!;
    expect(isScTokenExpiringSoon(fresh, SC_PROACTIVE_REFRESH_LEEWAY_SEC, nowMs + delay)).toBe(true);
    expect(isScJwtNewer(fresh, expiringSoon)).toBe(true);
    expect(isScJwtNewer(expiringSoon, fresh)).toBe(false);
    expect(isScJwtNewer('2-opaque', fresh)).toBe(false);
  });
});
