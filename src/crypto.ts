/** AES-256-GCM for the LinkedIn token at rest. Stored form: v1:<iv>:<ciphertext>, base64. */
import { getSettings } from './settings';

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}
export function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export function b64urlEncode(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array {
  return b64decode(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
}

export async function encKey(env: Env): Promise<CryptoKey> {
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY secret is not set');
  const raw = b64decode(env.TOKEN_ENC_KEY);
  if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return 'v1:' + b64encode(iv) + ':' + b64encode(new Uint8Array(ct));
}
export async function decryptToken(env: Env, stored: string): Promise<string> {
  const [version, ivB64, ctB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('Stored token is in an unknown format. Connect LinkedIn again.');
  const key = await encKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(ivB64) }, key, b64decode(ctB64));
  return new TextDecoder().decode(pt);
}
export async function getLinkedInToken(env: Env): Promise<string | null> {
  const stored = (await getSettings(env)).li_token;
  return stored ? decryptToken(env, stored) : null;
}
