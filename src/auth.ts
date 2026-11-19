/**
 * Two ways in:
 *  - the dashboard signs in once with the password (POST /api/login) and then
 *    carries a signed, expiring session cookie (HttpOnly, Secure, SameSite=Strict);
 *  - scripts send the password as a Bearer token.
 * Password checks are rate limited per IP. Session cookies are HMAC-signed, so
 * they cannot be guessed, and changing DASH_PASSWORD signs every session out.
 */
import { b64urlDecode, b64urlEncode } from './crypto';
import { getCookie } from './http';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_S = 7 * 86_400;

const enc = new TextEncoder();

export async function passwordMatches(provided: string, env: Env): Promise<boolean> {
  if (!provided || !env.DASH_PASSWORD) return false;
  // hashing first makes both sides the same length for timingSafeEqual
  const a = await crypto.subtle.digest('SHA-256', enc.encode(provided));
  const b = await crypto.subtle.digest('SHA-256', enc.encode(env.DASH_PASSWORD));
  return crypto.subtle.timingSafeEqual(a, b);
}

async function sessionKey(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', enc.encode('session-v1|' + env.TOKEN_ENC_KEY + '|' + env.DASH_PASSWORD));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(env: Env, now = Date.now()): Promise<string> {
  const payload = 'v1.' + (Math.floor(now / 1000) + SESSION_TTL_S);
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(payload));
  return payload + '.' + b64urlEncode(new Uint8Array(sig));
}

export async function verifySession(env: Env, value: string | null, now = Date.now()): Promise<boolean> {
  const m = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (!m || Number(m[2]) * 1000 <= now) return false;
  return crypto.subtle.verify('HMAC', await sessionKey(env), b64urlDecode(m[3]), enc.encode(m[1]));
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_S): string {
  return SESSION_COOKIE + '=' + value + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; Secure; SameSite=Strict';
}

/** One attempt against a rate limit binding; true when the caller is still under it. */
export async function underLimit(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limiter) return true;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return (await limiter.limit({ key: ip })).success;
}

export type AuthResult = 'ok' | 'denied' | 'limited';

export async function checkAuth(request: Request, env: Env): Promise<AuthResult> {
  const bearer = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    if (!(await underLimit(env.AUTH_LIMIT, request))) return 'limited';
    return (await passwordMatches(bearer, env)) ? 'ok' : 'denied';
  }
  if (!(await verifySession(env, getCookie(request, SESSION_COOKIE)))) return 'denied';
  // SameSite=Strict already keeps the cookie off cross-site requests; checking
  // Origin on writes is a second, independent guard against CSRF.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.get('Origin') !== new URL(request.url).origin) return 'denied';
  }
  return 'ok';
}
