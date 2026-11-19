import { encryptToken } from './crypto';
import { getCookie } from './http';
import { getSettings, setSetting } from './settings';

export const OAUTH_COOKIE = 'oauth_state';
const STATE_TTL_MS = 10 * 60_000;

/** Cookie that ties a pending OAuth state to the browser that started it. */
export function oauthStateCookie(state: string, maxAge = STATE_TTL_MS / 1000): string {
  // Lax, not Strict: the callback is a top-level redirect from linkedin.com
  return OAUTH_COOKIE + '=' + state + '; Max-Age=' + maxAge + '; Path=/oauth; HttpOnly; Secure; SameSite=Lax';
}

export async function handleOAuthCallback(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.searchParams.get('error')) {
    // the query string is attacker-controlled, so it is logged, never shown
    console.error(JSON.stringify({ event: 'oauth_denied', error: url.searchParams.get('error')?.slice(0, 100) }));
    return oauthErrorPage('LinkedIn did not grant access. Start again from Settings, Connect LinkedIn.');
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return oauthErrorPage('No authorization code here. Start from Settings, Connect LinkedIn.');

  // The state must match both the pending value in D1 and this browser's cookie.
  // It is consumed only on a match, so a forged callback cannot cancel a real one.
  const [storedState, startedAt] = ((await getSettings(env)).oauth_state ?? '').split(':');
  if (!storedState || state !== storedState || getCookie(request, OAUTH_COOKIE) !== state || Date.now() - Number(startedAt) > STATE_TTL_MS) {
    return oauthErrorPage('This sign-in link is stale or was started in another browser. Start again from Settings, Connect LinkedIn.');
  }
  await env.DB.prepare("DELETE FROM settings WHERE key = 'oauth_state'").run();
  if (!env.LI_CLIENT_SECRET) return oauthErrorPage('Worker secret LI_CLIENT_SECRET is not set.');

  // URLSearchParams percent-encodes the secret, which can end in "=="; sent raw,
  // LinkedIn answers invalid_client.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: env.LI_CLIENT_ID,
    client_secret: env.LI_CLIENT_SECRET,
    redirect_uri: url.origin + '/oauth/callback',
  });
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await response
    .json<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>()
    .catch(() => null);
  if (!response.ok || !data?.access_token) {
    console.error(JSON.stringify({ event: 'oauth_exchange_failed', status: response.status, error: data?.error }));
    return oauthErrorPage('Token exchange failed (' + response.status + '): ' + (data?.error_description ?? data?.error ?? 'unknown'));
  }

  await setSetting(env, 'li_token', await encryptToken(env, data.access_token));
  await setSetting(env, 'li_token_saved_at', String(Date.now()));
  await env.DB.prepare("DELETE FROM settings WHERE key = 'li_person_urn'").run();
  return new Response(null, { status: 302, headers: { Location: '/#oauth=ok', 'Set-Cookie': oauthStateCookie('', 0) } });
}

export function oauthErrorPage(message: string): Response {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return new Response(
    '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:460px;margin:80px auto;line-height:1.5">' +
      '<h3>LinkedIn connect failed</h3><p>' + safe + '</p><p><a href="/">Back to dashboard</a></p>',
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
