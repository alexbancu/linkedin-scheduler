import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/auth';
import { setSetting } from '../src/settings';

const ORIGIN = 'https://example.com';
const bearer = { Authorization: 'Bearer test-password' };
const req = (path: string, init: RequestInit = {}) => SELF.fetch(ORIGIN + path, init);
const jsonBody = (b: unknown) => ({ 'Content-Type': 'application/json', body: JSON.stringify(b) });

async function login(password = 'test-password') {
  return req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.' + Math.floor(Math.random() * 250) }, body: JSON.stringify({ password }) });
}
function cookieFrom(res: Response): string {
  return (res.headers.get('Set-Cookie') ?? '').split(';')[0];
}

describe('authentication', () => {
  it('rejects API calls without a session or the password', async () => {
    expect((await req('/api/state')).status).toBe(401);
    expect((await req('/api/state', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await req('/api/state', { headers: { Cookie: 'sid=v1.9999999999.' + 'A'.repeat(43) } })).status).toBe(401);
  });

  it('accepts the password as a Bearer token for scripts', async () => {
    expect((await req('/api/state', { headers: bearer })).status).toBe(200);
  });

  it('logs in with a signed HttpOnly cookie, and the dashboard never holds the password', async () => {
    expect((await login('wrong')).status).toBe(401);
    const res = await login();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/^sid=v1\.\d+\.[\w-]{43}; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(setCookie).not.toContain('test-password');
    expect((await req('/api/state', { headers: { Cookie: cookieFrom(res) } })).status).toBe(200);
  });

  it('refuses an expired or tampered session', async () => {
    const old = await createSession(env, Date.now() - 8 * 86_400_000);
    expect((await req('/api/state', { headers: { Cookie: 'sid=' + old } })).status).toBe(401);
    const good = await createSession(env);
    const tampered = good.replace(/\.(\d+)\./, (_m, exp) => '.' + (Number(exp) + 999) + '.');
    expect((await req('/api/state', { headers: { Cookie: 'sid=' + tampered } })).status).toBe(401);
  });

  it('refuses a cookie-authenticated write from another origin (CSRF)', async () => {
    const cookie = 'sid=' + (await createSession(env));
    const write = (origin?: string) =>
      req('/api/posts', { method: 'POST', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    expect((await write('https://evil.example')).status).toBe(401);
    expect((await write()).status).toBe(401);
    expect((await write(ORIGIN)).status).toBe(200);
  });

  it('rate limits password guesses per IP', async () => {
    const guess = () =>
      req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ password: 'guess' }) });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await guess()).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe('HTTP surface', () => {
  it('sends security headers on every response, with no inline script allowed', async () => {
    for (const path of ['/', '/app.js', '/api/state', '/missing']) {
      const res = await req(path);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("script-src 'self';");
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });

  it('serves the dashboard script from its own file', async () => {
    const html = await (await req('/')).text();
    expect(html).toContain('<script src="/app.js"></script>');
    expect(html).not.toMatch(/<script\s*>|onclick=/i);
    const js = await req('/app.js');
    expect(js.headers.get('Content-Type')).toContain('javascript');
  });

  it('stores a saved token encrypted and never returns it', async () => {
    const save = await req('/api/token', { method: 'POST', headers: { ...bearer, ...jsonBody({}) }, body: JSON.stringify({ token: 'plain-secret' }) });
    const body = await save.text();
    expect(body).not.toContain('plain-secret');
    expect(JSON.parse(body).token).toEqual({ set: true, ageDays: 0 });
  });

  it('answers malformed JSON with 400', async () => {
    const res = await req('/api/posts', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('creates a draft and validates input', async () => {
    const post = (b: unknown) => req('/api/posts', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    expect((await post({ text: '' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(3001) })).status).toBe(400);
    const ok = await post({ text: 'Hello', queue: 'engineers' });
    expect(ok.status).toBe(200);
    const state = await ok.json<{ drafts: { text: string; status: string }[] }>();
    expect(state.drafts).toContainEqual(expect.objectContaining({ text: 'Hello', status: 'draft' }));
  });
});

describe('OAuth callback', () => {
  async function pending(state: string) {
    await setSetting(env, 'oauth_state', state + ':' + Date.now());
  }
  const stored = () => env.DB.prepare("SELECT value FROM settings WHERE key = 'oauth_state'").first<{ value: string }>();

  it('never shows text taken from the query string', async () => {
    const res = await req('/oauth/callback?error=x&error_description=' + encodeURIComponent('Call +1 555 to verify your account'));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('555');
  });

  it('ignores a forged callback without cancelling the real pending sign-in', async () => {
    await pending('real-state');
    const forged = await req('/oauth/callback?code=c&state=guess', { headers: { Cookie: 'oauth_state=guess' } });
    expect(forged.status).toBe(400);
    expect((await stored())?.value).toMatch(/^real-state:/);
  });

  it('requires the state cookie from the browser that started the sign-in', async () => {
    await pending('real-state');
    const otherBrowser = await req('/oauth/callback?code=c&state=real-state');
    expect(otherBrowser.status).toBe(400);
    expect((await stored())?.value).toMatch(/^real-state:/);
  });
});
