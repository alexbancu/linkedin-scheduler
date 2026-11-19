import { LINKEDIN_VERSION, MEDIA_LIMITS } from './config';
import { getLinkedInToken } from './crypto';
import { buildContent, escapeCommentary, formatForLinkedIn } from './format';
import { json } from './http';
import { getSettings, setSetting } from './settings';
import type { MediaSpec, PostRow } from './types';

export function liHeaders(token: string): Record<string, string> {
  return {
    Authorization: 'Bearer ' + token,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
}

export async function getPersonUrn(env: Env, token: string): Promise<string> {
  const settings = await getSettings(env);
  if (settings.li_person_urn) return settings.li_person_urn;
  const response = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok) throw new Error('LinkedIn userinfo failed (' + response.status + '): ' + (await response.text()).slice(0, 300));
  const body = await response.json<{ sub: string }>();
  const urn = 'urn:li:person:' + body.sub;
  await setSetting(env, 'li_person_urn', urn);
  return urn;
}

/** Attach-time upload: streams the incoming file to LinkedIn, returns the asset URN. */
export async function handleMediaUpload(request: Request, url: URL, env: Env): Promise<Response> {
  const kind = url.searchParams.get('kind') as MediaSpec['kind'] | null;
  const name = (url.searchParams.get('name') ?? 'file').slice(0, 200);
  if (!kind || !(kind in MEDIA_LIMITS)) return json({ error: 'kind must be images, document, or video' }, 400);
  const limit = MEDIA_LIMITS[kind];

  const contentType = request.headers.get('Content-Type') ?? '';
  const baseType = contentType.split(';')[0].trim().toLowerCase();
  if (!limit.mimes.includes(baseType)) return json({ error: 'Unsupported file type for ' + kind + ' (' + limit.label + ')' }, 400);

  const lenHeader = request.headers.get('Content-Length');
  const size = lenHeader ? Number(lenHeader) : NaN;
  if (!Number.isFinite(size) || size <= 0) return json({ error: 'Missing Content-Length' }, 400);
  if (size > limit.maxBytes) return json({ error: 'File too large (' + limit.label + ')' }, 400);
  if (!request.body) return json({ error: 'Empty body' }, 400);

  const token = await getLinkedInToken(env);
  if (!token) return json({ error: 'Connect LinkedIn first (Settings → token), then attach media.' }, 400);
  const owner = await getPersonUrn(env, token);

  try {
    const urn =
      kind === 'video'
        ? await liUploadVideo(token, owner, request.body, size)
        : await liUploadSinglePart(kind, token, owner, request.body, size, baseType);
    return json({ urn, name, kind, size });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
}

/**
 * Preview data for an uploaded video, read back from LinkedIn: `thumbnail` is
 * the cover frame LinkedIn generated (what the feed shows before play) and
 * `downloadUrl` is the processed MP4 it will serve. Both are short-lived
 * signed licdn.com URLs, so nothing is stored — the client re-asks when needed.
 */
export async function handleVideoInfo(url: URL, env: Env): Promise<Response> {
  const urn = url.searchParams.get('urn') ?? '';
  if (!/^urn:li:video:[A-Za-z0-9_-]+$/.test(urn)) return json({ error: 'Invalid video URN' }, 400);
  const token = await getLinkedInToken(env);
  if (!token) return json({ error: 'Connect LinkedIn first (Settings → token).' }, 400);

  const response = await fetch('https://api.linkedin.com/rest/videos/' + encodeURIComponent(urn), { headers: liHeaders(token) });
  if (!response.ok) {
    return json({ error: 'LinkedIn video lookup failed (' + response.status + '): ' + (await response.text()).slice(0, 300) }, 502);
  }
  const v = await response.json<{
    status?: string;
    thumbnail?: string;
    downloadUrl?: string;
    downloadUrlExpiresAt?: number;
    duration?: number;
    aspectRatioWidth?: number;
    aspectRatioHeight?: number;
    processingFailureReason?: string;
  }>();
  return json({
    status: v.status ?? 'UNKNOWN',
    thumbnail: licdnUrl(v.thumbnail),
    downloadUrl: licdnUrl(v.downloadUrl),
    expiresAt: v.downloadUrlExpiresAt ?? null,
    durationMs: v.duration ?? null,
    aspect: v.aspectRatioWidth && v.aspectRatioHeight ? v.aspectRatioWidth / v.aspectRatioHeight : null,
    failure: v.processingFailureReason ?? null,
  });
}

// Only hand LinkedIn CDN URLs to the page (the CSP allows *.licdn.com for img/media, nothing else).
export function licdnUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.licdn.com') ? u : null;
  } catch {
    return null;
  }
}

/**
 * Upload URLs come back from LinkedIn and the request to them carries the access
 * token, so only https URLs on a linkedin.com host are accepted.
 */
export function linkedInUploadUrl(u: string): string {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('LinkedIn returned an invalid upload URL');
  }
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'linkedin.com' || parsed.hostname.endsWith('.linkedin.com'))) {
    throw new Error('Refusing to send the token to an upload host outside linkedin.com: ' + parsed.hostname);
  }
  return u;
}

/** Image or document: one initializeUpload, then a single streamed PUT of the bytes. */
export async function liUploadSinglePart(
  kind: 'images' | 'document',
  token: string,
  owner: string,
  body: ReadableStream<Uint8Array>,
  size: number,
  contentType: string
): Promise<string> {
  const resource = kind === 'images' ? 'images' : 'documents';
  const init = await fetch('https://api.linkedin.com/rest/' + resource + '?action=initializeUpload', {
    method: 'POST',
    headers: liHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  if (!init.ok) throw new Error(kind + ' init failed (' + init.status + '): ' + (await init.text()).slice(0, 300));
  const j = await init.json<{ value: { uploadUrl: string; image?: string; document?: string } }>();
  const uploadUrl = j.value.uploadUrl;
  const urn = (kind === 'images' ? j.value.image : j.value.document) as string;

  const put = await fetch(linkedInUploadUrl(uploadUrl), {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType, 'Content-Length': String(size) },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (put.status !== 200 && put.status !== 201) throw new Error(kind + ' upload failed (' + put.status + '): ' + (await put.text()).slice(0, 300));
  return urn;
}

/** Reads a stream in exact-sized chunks without buffering the whole file. */
export class StreamChunker {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private done = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async read(n: number): Promise<Uint8Array> {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      const nb = new Uint8Array(this.buf.length + value.length);
      nb.set(this.buf, 0);
      nb.set(value, this.buf.length);
      this.buf = nb;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

/** Video: multipart upload in 4MB parts, capture ETags, finalize. */
export async function liUploadVideo(token: string, owner: string, body: ReadableStream<Uint8Array>, fileSizeBytes: number): Promise<string> {
  const init = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
    method: 'POST',
    headers: liHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes, uploadCaptions: false, uploadThumbnail: false } }),
  });
  if (!init.ok) throw new Error('video init failed (' + init.status + '): ' + (await init.text()).slice(0, 300));
  const j = await init.json<{
    value: { video: string; uploadToken: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] };
  }>();
  const { video, uploadToken, uploadInstructions } = j.value;

  const chunker = new StreamChunker(body);
  const etags: string[] = [];
  for (const part of uploadInstructions) {
    const partLen = part.lastByte - part.firstByte + 1;
    const chunk = await chunker.read(partLen);
    const put = await fetch(linkedInUploadUrl(part.uploadUrl), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length) },
      body: chunk,
    });
    if (put.status !== 200 && put.status !== 201) throw new Error('video part upload failed (' + put.status + ')');
    etags.push((put.headers.get('etag') ?? '').replace(/^"|"$/g, ''));
  }

  const fin = await fetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
    method: 'POST',
    headers: liHeaders(token),
    body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } }),
  });
  if (!fin.ok) throw new Error('video finalize failed (' + fin.status + '): ' + (await fin.text()).slice(0, 300));
  return video;
}

export async function publishToLinkedIn(env: Env, post: PostRow, force: boolean): Promise<string> {
  const text = formatForLinkedIn(post.text);
  if (!force && /\[[^\]]*\]/.test(text)) {
    throw new Error('Post contains unfilled [placeholders] — fix the text or use force publish.');
  }
  const token = await getLinkedInToken(env);
  if (!token) throw new Error('No LinkedIn token saved. Add one in Settings.');

  const settings = await getSettings(env);
  const savedAt = settings.li_token_saved_at ? Number(settings.li_token_saved_at) : 0;
  const ageDays = savedAt ? Math.floor((Date.now() - savedAt) / 86_400_000) : null;

  const author = await getPersonUrn(env, token);
  const media = post.media ? (JSON.parse(post.media) as MediaSpec) : null;
  const content = buildContent(media);

  const payload: Record<string, unknown> = {
    author,
    commentary: escapeCommentary(text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (content) payload.content = content;

  const response = await fetch('https://api.linkedin.com/rest/posts', { method: 'POST', headers: liHeaders(token), body: JSON.stringify(payload) });
  if (response.status !== 201) {
    const detail = (await response.text()).slice(0, 500);
    const hint = ageDays !== null && ageDays > 45 ? ' (token is ' + ageDays + ' days old — it may have expired)' : '';
    throw new Error('LinkedIn post failed (' + response.status + ')' + hint + ': ' + detail);
  }
  return 'https://www.linkedin.com/feed/update/' + response.headers.get('x-restli-id');
}
