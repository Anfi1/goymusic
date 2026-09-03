import { CapacitorHttp } from '@capacitor/core';

// Все запросы идут нативным HTTP Capacitor'а, а не fetch: WebView упрётся в CORS
// (api.music.yandex.net не отдаёт Access-Control-Allow-Origin), нативный клиент -- нет.
export interface HttpResult<T = any> {
  status: number;
  data: T;
}

export async function httpRequest<T = any>(opts: {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: any;
}): Promise<HttpResult<T>> {
  const res = await CapacitorHttp.request({
    url: opts.url,
    method: opts.method || 'GET',
    headers: opts.headers,
    params: opts.params,
    data: opts.data,
    // Иначе плагин попытается сам угадать формат и ломает form-urlencoded.
    responseType: 'json',
  });
  return { status: res.status, data: res.data as T };
}

// MD5 нужен для подписи ссылки на mp3 (у Яндекса это md5(salt + path + s)).
// В WebView нет ни node:crypto, ни MD5 в SubtleCrypto -- поэтому свой, компактный.
export function md5(input: string): string {
  const toBytes = (s: string) => {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  };

  const bytes = toBytes(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff);

  const K: number[] = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++) {
      const o = chunk + i * 4;
      M[i] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const hex = (n: number) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
