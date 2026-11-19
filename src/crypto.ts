import { getSettings, setSetting } from './settings';

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}
export function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export async function encKey(env: Env): Promise<CryptoKey> {
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY secret is not set');
  return crypto.subtle.importKey('raw', b64decode(env.TOKEN_ENC_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return 'v1:' + b64encode(iv) + ':' + b64encode(new Uint8Array(ct));
}
export async function decryptToken(env: Env, stored: string): Promise<string> {
  const [, ivB64, ctB64] = stored.split(':');
  const key = await encKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(ivB64) }, key, b64decode(ctB64));
  return new TextDecoder().decode(pt);
}
export async function getLinkedInToken(env: Env): Promise<string | null> {
  const settings = await getSettings(env);
  const stored = settings.li_token;
  if (!stored) return null;
  if (stored.startsWith('v1:')) return decryptToken(env, stored);
  try {
    await setSetting(env, 'li_token', await encryptToken(env, stored));
  } catch (e) {
    console.error(JSON.stringify({ event: 'token_migrate_failed', error: String(e) }));
  }
  return stored;
}
