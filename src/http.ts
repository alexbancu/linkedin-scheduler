export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Reads one cookie from the request. */
export function getCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** An error whose message is safe and useful to show the dashboard owner. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
