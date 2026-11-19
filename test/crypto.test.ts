import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, getLinkedInToken } from '../src/crypto';
import { getSettings, setSetting } from '../src/settings';

describe('LinkedIn token at rest', () => {
  it('round-trips through AES-256-GCM', async () => {
    const stored = await encryptToken(env, 'secret-token');
    expect(stored).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain('secret-token');
    expect(await decryptToken(env, stored)).toBe('secret-token');
  });

  it('uses a fresh IV every time', async () => {
    expect(await encryptToken(env, 'same')).not.toBe(await encryptToken(env, 'same'));
  });

  it('rejects ciphertext that was tampered with', async () => {
    const [v, iv, ct] = (await encryptToken(env, 'secret-token')).split(':');
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(decryptToken(env, [v, iv, flipped].join(':'))).rejects.toThrow();
  });

  it('encrypts a legacy plaintext token the first time it is read', async () => {
    await setSetting(env, 'li_token', 'old-plaintext');
    expect(await getLinkedInToken(env)).toBe('old-plaintext');
    const stored = (await getSettings(env)).li_token;
    expect(stored.startsWith('v1:')).toBe(true);
    expect(await getLinkedInToken(env)).toBe('old-plaintext');
  });
});
