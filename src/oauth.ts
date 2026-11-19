import { encryptToken } from './crypto';
import { json } from './http';
import { getSettings, setSetting } from './settings';

export async function handleOAuthCallback(url: URL, env: Env): Promise<Response> {
  const liError = url.searchParams.get('error');
  if (liError) {
    return oauthErrorPage('LinkedIn returned "' + liError + '": ' + (url.searchParams.get('error_description') ?? ''));
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // a bare visit (stale tab reload) must not consume the pending state
  if (!code || !state) {
    return oauthErrorPage('No authorization code here — start from Settings → Connect LinkedIn (and close old callback tabs).');
  }

  const settings = await getSettings(env);
  const stored = settings.oauth_state ?? '';
  // single-use: consume the state only for a real callback attempt
  await env.DB.prepare("DELETE FROM settings WHERE key = 'oauth_state'").run();
  const [storedState, startedAt] = stored.split(':');
  if (state !== storedState || Date.now() - Number(startedAt) > 10 * 60_000) {
    return oauthErrorPage('State mismatch or expired — start again from Settings → Connect LinkedIn.');
  }
  if (!env.LI_CLIENT_SECRET) return oauthErrorPage('Worker secret LI_CLIENT_SECRET is not set.');

  // URLSearchParams percent-encodes the secret (it ends in "==") — sending it
  // raw is exactly the invalid_client trap the manual curl flow fell into.
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
  return new Response(null, { status: 302, headers: { Location: '/#oauth=ok' } });
}

export function oauthErrorPage(message: string): Response {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return new Response(
    '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:460px;margin:80px auto;line-height:1.5">' +
      '<h3>LinkedIn connect failed</h3><p>' + safe + '</p><p><a href="/">Back to dashboard</a></p>',
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
