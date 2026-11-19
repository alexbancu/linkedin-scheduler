/**
 * LinkedIn Scheduler: a Cloudflare Worker that publishes approved LinkedIn posts
 * (text, photos, PDF carousels, video) on weekly slots through the official API.
 *
 * fetch:     dashboard (HTML + script), login, JSON API, OAuth callback
 * scheduled: every 15 minutes, publishes the next approved post when a queue's
 *            weekly slot is open
 */
import { handleApi } from './api';
import { checkAuth, createSession, passwordMatches, sessionCookie, underLimit } from './auth';
import { SECURITY_HEADERS } from './config';
import DASHBOARD_JS from './dashboard/app.js';
import DASHBOARD_HTML from './dashboard/index.html';
import { HttpError, json } from './http';
import { handleOAuthCallback } from './oauth';
import { publishCheck } from './publish';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withHeaders(await route(request, env));
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(publishCheck(env));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;

  if (method === 'GET' && url.pathname === '/') {
    return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (method === 'GET' && url.pathname === '/app.js') {
    return new Response(DASHBOARD_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
  }

  // The OAuth callback is a browser redirect from LinkedIn, so it cannot carry a
  // session cookie with SameSite=Strict. The state value and its cookie protect it.
  if (method === 'GET' && url.pathname === '/oauth/callback') return handleOAuthCallback(request, url, env);

  if (method === 'POST' && url.pathname === '/api/login') {
    if (!(await underLimit(env.LOGIN_LIMIT, request))) return json({ error: 'Too many attempts. Wait a minute.' }, 429);
    const body = await request.json<{ password?: unknown }>().catch(() => ({ password: '' }));
    if (!(await passwordMatches(typeof body.password === 'string' ? body.password : '', env))) {
      return json({ error: 'Wrong password' }, 401);
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(await createSession(env)) });
  }
  if (method === 'POST' && url.pathname === '/api/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (url.pathname.startsWith('/api/')) {
    const auth = await checkAuth(request, env);
    if (auth === 'limited') return json({ error: 'Too many attempts. Wait a minute.' }, 429);
    if (auth !== 'ok') return json({ error: 'unauthorized' }, 401);
    try {
      return await handleApi(request, url, env);
    } catch (e) {
      if (e instanceof SyntaxError) return json({ error: 'Request body is not valid JSON' }, 400);
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      // anything unexpected stays in the logs; the response says only that it failed
      console.error(JSON.stringify({ event: 'api_error', path: url.pathname, error: String(e) }));
      return json({ error: 'Internal error. The Worker logs have the details.' }, 500);
    }
  }

  return new Response('Not found', { status: 404 });
}

function withHeaders(response: Response): Response {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}
