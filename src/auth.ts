export async function checkAuth(request: Request, env: Env): Promise<boolean> {
  const provided = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  const enc = new TextEncoder();
  const a = await crypto.subtle.digest('SHA-256', enc.encode(provided));
  const b = await crypto.subtle.digest('SHA-256', enc.encode(env.DASH_PASSWORD));
  return crypto.subtle.timingSafeEqual(a, b);
}
