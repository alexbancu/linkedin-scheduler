import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../src/crypto';
import { publishCheck } from '../src/publish';
import { setSetting } from '../src/settings';

// Tuesday 20 Oct 2026, 15:30 in Bucharest: inside the default engineers slot (Tue 15:00)
const IN_SLOT = new Date('2026-10-20T12:30:00Z');
const OUTSIDE_SLOT = new Date('2026-10-20T16:00:00Z');

type Row = { status: string; post_url: string | null; last_error: string | null };
const post = (id: string) => env.DB.prepare('SELECT status, post_url, last_error FROM posts WHERE id = ?').bind(id).first<Row>();

async function addApproved(id: string, text: string, approvedAt = 1) {
  await env.DB.prepare("INSERT INTO posts (id, text, status, created_at, approved_at, queue) VALUES (?, ?, 'approved', ?, ?, 'engineers')")
    .bind(id, text, approvedAt, approvedAt)
    .run();
}

let linkedIn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM posts; DELETE FROM slot_runs; DELETE FROM settings;');
  await setSetting(env, 'li_token', await encryptToken(env, 'test-token'));
  await setSetting(env, 'li_person_urn', 'urn:li:person:test');
  // LinkedIn's Posts API answers 201 with the new post's URN in x-restli-id
  linkedIn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1234567890123456789' } }));
  vi.stubGlobal('fetch', linkedIn);
});
afterEach(() => vi.unstubAllGlobals());

describe('publishCheck', () => {
  it('publishes the oldest approved post when the slot is open', async () => {
    await addApproved('a', 'first', 1);
    await addApproved('b', 'second', 2);
    await publishCheck(env, IN_SLOT);

    expect(linkedIn).toHaveBeenCalledTimes(1);
    const [url, init] = linkedIn.mock.calls[0];
    expect(String(url)).toBe('https://api.linkedin.com/rest/posts');
    expect(JSON.parse(String(init?.body))).toMatchObject({ author: 'urn:li:person:test', commentary: 'first', lifecycleState: 'PUBLISHED' });
    expect(await post('a')).toMatchObject({ status: 'posted', post_url: 'https://www.linkedin.com/feed/update/urn:li:share:1234567890123456789' });
    expect((await post('b'))?.status).toBe('approved');
  });

  it('does nothing outside the slot window', async () => {
    await addApproved('a', 'first');
    await publishCheck(env, OUTSIDE_SLOT);
    expect(linkedIn).not.toHaveBeenCalled();
  });

  it('never publishes twice for one slot, even when cron runs overlap', async () => {
    await addApproved('a', 'first', 1);
    await addApproved('b', 'second', 2);
    await Promise.all([publishCheck(env, IN_SLOT), publishCheck(env, IN_SLOT), publishCheck(env, IN_SLOT)]);
    // a later run inside the same window finds the slot already claimed
    await publishCheck(env, new Date(IN_SLOT.getTime() + 15 * 60_000));

    expect(linkedIn).toHaveBeenCalledTimes(1);
    const runs = await env.DB.prepare('SELECT slot_key, status FROM slot_runs').all();
    expect(runs.results).toEqual([{ slot_key: 'engineers:2026-10-20', status: 'posted' }]);
    expect((await post('b'))?.status).toBe('approved');
  });

  it('refuses a post with unfilled [placeholders] and does not retry it', async () => {
    await addApproved('a', 'Hi [name], quick one');
    await publishCheck(env, IN_SLOT);

    expect(linkedIn).not.toHaveBeenCalled();
    const row = await post('a');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toMatch(/placeholders/);
  });

  it('marks the post failed with LinkedIn\'s answer when the API rejects it', async () => {
    linkedIn.mockResolvedValueOnce(new Response('{"message":"Unauthorized"}', { status: 401 }));
    await addApproved('a', 'first');
    await publishCheck(env, IN_SLOT);

    const row = await post('a');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('401');
  });

  it('respects the account-wide minimum gap between posts', async () => {
    await env.DB.prepare("INSERT INTO posts (id, text, status, created_at, posted_at, queue) VALUES ('old', 'x', 'posted', 0, ?, 'devshops')")
      .bind(IN_SLOT.getTime() - 3 * 3_600_000)
      .run();
    await addApproved('a', 'first');
    await publishCheck(env, IN_SLOT);
    expect(linkedIn).not.toHaveBeenCalled();
  });
});
