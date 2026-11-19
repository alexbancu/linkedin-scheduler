/**
 * LinkedIn Scheduler: a Cloudflare Worker that publishes approved LinkedIn posts
 * (text, photos, PDF carousels, video) on weekly slots through the official API.
 *
 * fetch:     dashboard UI + JSON API (password protected, Bearer auth)
 * scheduled: every 15 minutes, publishes the next approved post when a queue's
 *            weekly slot is open
 */
import { handleApi } from './api';
import { checkAuth } from './auth';
import { SECURITY_HEADERS } from './config';
import DASHBOARD_HTML from './dashboard.html';
import { json } from './http';
import { handleOAuthCallback } from './oauth';
import { publishCheck } from './publish';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return withHeaders(new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    }

    // The OAuth callback is a browser redirect from LinkedIn, so it cannot carry a
    // Bearer header. The single-use state token protects it instead.
    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      return withHeaders(await handleOAuthCallback(url, env));
    }

    if (url.pathname.startsWith('/api/')) {
      if (!(await checkAuth(request, env))) return withHeaders(json({ error: 'unauthorized' }, 401));
      try {
        return withHeaders(await handleApi(request, url, env));
      } catch (e) {
        console.error(JSON.stringify({ event: 'api_error', path: url.pathname, error: String(e) }));
        return withHeaders(json({ error: String(e instanceof Error ? e.message : e) }, 500));
      }
    }

    return withHeaders(new Response('Not found', { status: 404 }));
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(publishCheck(env));
  },
} satisfies ExportedHandler<Env>;

function withHeaders(response: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
  return response;
}
