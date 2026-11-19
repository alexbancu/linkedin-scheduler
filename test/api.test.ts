import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const auth = { Authorization: 'Bearer test-password' };

describe('HTTP surface', () => {
  it('rejects API calls without the dashboard password', async () => {
    const res = await SELF.fetch('https://example.com/api/state');
    expect(res.status).toBe(401);
    const wrong = await SELF.fetch('https://example.com/api/state', { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('sends security headers on every response', async () => {
    for (const path of ['/', '/api/state', '/missing']) {
      const res = await SELF.fetch('https://example.com' + path);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    }
  });

  it('stores a saved token encrypted and never returns it', async () => {
    const save = await SELF.fetch('https://example.com/api/token', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'plain-secret' }),
    });
    expect(save.status).toBe(200);
    const body = await save.text();
    expect(body).not.toContain('plain-secret');
    expect(JSON.parse(body).token).toEqual({ set: true, ageDays: 0 });
  });

  it('creates a draft and validates input', async () => {
    const post = (b: unknown) =>
      SELF.fetch('https://example.com/api/posts', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    expect((await post({ text: '' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(3001) })).status).toBe(400);
    const ok = await post({ text: 'Hello', queue: 'engineers' });
    expect(ok.status).toBe(200);
    const state = await ok.json<{ drafts: { text: string; status: string }[] }>();
    expect(state.drafts).toEqual([expect.objectContaining({ text: 'Hello', status: 'draft' })]);
  });
});
