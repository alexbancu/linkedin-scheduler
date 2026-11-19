import { ISO_DATE, buildAnalytics, importAnalytics, savePageStats, type AnalyticsImport, type PageStatsBody } from './analytics';
import { MAX_COMMENT_CHARS, MAX_POST_CHARS, MAX_THUMB_CHARS, MEDIA_LIMITS, QUEUES, STAGES, isQueue, isStage, qKey, queueSettings, type QueueKey, type Stage } from './config';
import { encryptToken, getLinkedInToken } from './crypto';
import { json } from './http';
import { handleMediaUpload, handleVideoInfo, publishToLinkedIn } from './linkedin';
import { getPost, markPosted, moveInQueue, postFirstComment } from './posts';
import { scheduleSlots, slotLabel } from './schedule';
import { getSettings, setSetting } from './settings';
import type { MediaItem, MediaSpec, PostRow } from './types';

export async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/state') return json(await buildState(env));


  // Attach media: stream the incoming file straight to LinkedIn, return asset URN
  if (method === 'POST' && pathname === '/api/media') return handleMediaUpload(request, url, env);

  // Video preview: LinkedIn's processed MP4 + the cover frame it will show in the feed
  if (method === 'GET' && pathname === '/api/media/video') return handleVideoInfo(url, env);

  if (method === 'POST' && pathname === '/api/posts') {
    const body = await request.json<{ text?: string; approve?: boolean; media?: MediaSpec | null; queue?: string; stage?: string | null; first_comment?: string | null }>();
    const queue: QueueKey = isQueue(body.queue) ? body.queue : 'engineers';
    const firstComment = (body.first_comment ?? '').trim() || null;
    if (firstComment && firstComment.length > MAX_COMMENT_CHARS) return json({ error: 'First comment exceeds ' + MAX_COMMENT_CHARS + ' characters' }, 400);
    const stage: Stage | null = isStage(body.stage) ? body.stage : null;
    const text = (body.text ?? '').trim();
    const media = validateMediaSpec(body.media);
    if (!text && !media) return json({ error: 'Post is empty (add text or media)' }, 400);
    if (text.length > MAX_POST_CHARS) return json({ error: 'Post exceeds ' + MAX_POST_CHARS + ' characters' }, 400);
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO posts (id, text, status, created_at, approved_at, media, queue, stage, first_comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(crypto.randomUUID(), text, body.approve ? 'approved' : 'draft', now, body.approve ? now : null, media ? JSON.stringify(media) : null, queue, stage, firstComment)
      .run();
    return json(await buildState(env));
  }

  const postMatch = pathname.match(/^\/api\/posts\/([0-9a-f-]+)(?:\/(publish|move|comment))?$/);
  if (postMatch) {
    const id = postMatch[1];
    const action = postMatch[2];

    if (method === 'POST' && action === 'publish') {
      const body = await request.json<{ force?: boolean }>().catch(() => ({ force: false }));
      const post = await getPost(env, id);
      if (post.status === 'posted') return json({ error: 'Already posted' }, 400);
      if (post.status === 'publishing') return json({ error: 'This post is being published right now' }, 400);
      const postUrl = await publishToLinkedIn(env, post, body.force === true);
      await markPosted(env, id, postUrl);
      return json(await buildState(env));
    }

    // (Re)run the first-comment step on a live post: retries a failed comment, or posts
    // a one-off comment when text is given (the stored first_comment is left as is).
    if (method === 'POST' && action === 'comment') {
      const body = await request.json<{ text?: string }>().catch(() => ({} as { text?: string }));
      const post = await getPost(env, id);
      if (post.status !== 'posted' || !post.post_url) return json({ error: 'Only a posted post can get a comment' }, 400);
      const status = await postFirstComment(env, id, post.post_url, body.text);
      return json({ first_comment_status: status });
    }

    if (method === 'POST' && action === 'move') {
      const body = await request.json<{ dir?: string }>();
      if (body.dir !== 'up' && body.dir !== 'down') return json({ error: "dir must be 'up' or 'down'" }, 400);
      await moveInQueue(env, id, body.dir);
      return json(await buildState(env));
    }

    if (method === 'PUT') {
      const body = await request.json<{ text?: string; status?: string; media?: MediaSpec | null; queue?: string; stage?: string | null; first_comment?: string | null }>();
      const post = await getPost(env, id);
      if (post.status === 'posted') return json({ error: 'Posted posts are read-only' }, 400);
      if (body.first_comment !== undefined) {
        const fc = (body.first_comment ?? '').trim() || null;
        if (fc && fc.length > MAX_COMMENT_CHARS) return json({ error: 'First comment exceeds ' + MAX_COMMENT_CHARS + ' characters' }, 400);
        await env.DB.prepare('UPDATE posts SET first_comment = ? WHERE id = ?').bind(fc, id).run();
      }
      if (post.status === 'publishing') return json({ error: 'This post is being published right now' }, 400);
      if (body.stage !== undefined) {
        if (body.stage !== null && !isStage(body.stage)) return json({ error: 'Stage must be tofu, mofu, bofu or empty' }, 400);
        await env.DB.prepare('UPDATE posts SET stage = ? WHERE id = ?').bind(body.stage, id).run();
      }
      if (body.queue !== undefined) {
        if (!isQueue(body.queue)) return json({ error: 'Unknown queue' }, 400);
        // a queued post moving to the other queue goes to the end of that queue
        await env.DB.prepare('UPDATE posts SET queue = ?, approved_at = CASE WHEN status = ? THEN ? ELSE approved_at END WHERE id = ?')
          .bind(body.queue, 'approved', Date.now(), id)
          .run();
      }
      if (typeof body.text === 'string') {
        const t = body.text.trim();
        if (t.length > MAX_POST_CHARS) return json({ error: 'Post exceeds ' + MAX_POST_CHARS + ' characters' }, 400);
        await env.DB.prepare('UPDATE posts SET text = ? WHERE id = ?').bind(t, id).run();
      }
      if (body.media !== undefined) {
        const media = validateMediaSpec(body.media);
        await env.DB.prepare('UPDATE posts SET media = ? WHERE id = ?').bind(media ? JSON.stringify(media) : null, id).run();
      }
      if (typeof body.status === 'string') {
        if (!['draft', 'approved', 'skipped'].includes(body.status)) return json({ error: 'Invalid status' }, 400);
        await env.DB.prepare('UPDATE posts SET status = ?, approved_at = ?, last_error = NULL WHERE id = ?')
          .bind(body.status, body.status === 'approved' ? Date.now() : null, id)
          .run();
      }
      return json(await buildState(env));
    }

    if (method === 'DELETE') {
      const post = await getPost(env, id);
      if (post.status === 'posted') return json({ error: 'Posted posts are read-only' }, 400);
      await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
      return json(await buildState(env));
    }
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await request.json<{
      queue?: string; post_day?: number; post_hour?: number; cadence_weeks?: number; min_gap_hours?: number;
      stage_target?: { tofu?: number; mofu?: number; bofu?: number };
    }>();
    if (body.stage_target) {
      for (const st of STAGES) {
        const v = body.stage_target[st];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v < 0 || v > 8) return json({ error: 'Stage targets must be 0-8 per 8 posts' }, 400);
        await setSetting(env, 'stage_target_' + st, String(v));
      }
    }
    const queue: QueueKey = isQueue(body.queue) ? body.queue : 'engineers';
    if (body.cadence_weeks !== undefined) {
      if (![1, 2, 3, 4].includes(body.cadence_weeks)) return json({ error: 'cadence_weeks must be 1-4' }, 400);
      await setSetting(env, qKey(queue, 'cadence_weeks'), String(body.cadence_weeks));
    }
    if (body.post_day !== undefined) {
      if (body.post_day < 0 || body.post_day > 6) return json({ error: 'post_day must be 0-6' }, 400);
      await setSetting(env, qKey(queue, 'post_day'), String(Math.trunc(body.post_day)));
    }
    if (body.post_hour !== undefined) {
      if (body.post_hour < 0 || body.post_hour > 23) return json({ error: 'post_hour must be 0-23' }, 400);
      await setSetting(env, qKey(queue, 'post_hour'), String(Math.trunc(body.post_hour)));
    }
    if (body.min_gap_hours !== undefined) {
      if (body.min_gap_hours < 0 || body.min_gap_hours > 72) return json({ error: 'min_gap_hours must be 0-72' }, 400);
      await setSetting(env, 'min_gap_hours', String(Math.trunc(body.min_gap_hours)));
    }
    return json(await buildState(env));
  }

  if (method === 'GET' && pathname === '/api/analytics') return json(await buildAnalytics(env));
  if (method === 'POST' && pathname === '/api/analytics/page-stats') {
    await savePageStats(env, await request.json<PageStatsBody>());
    return json(await buildAnalytics(env));
  }
  if (method === 'POST' && pathname === '/api/analytics/lifetime') {
    const body = await request.json<{ checked_on?: string; items?: { id: string; impressions: number }[] }>();
    if (!ISO_DATE.test(body.checked_on ?? '')) return json({ error: 'checked_on must be YYYY-MM-DD' }, 400);
    const items = (body.items ?? []).filter((it) => /^\d{19}$/.test(String(it.id)) && Number.isInteger(it.impressions) && it.impressions >= 0).slice(0, 200);
    if (items.length) {
      await env.DB.batch(
        items.map((it) =>
          env.DB.prepare('INSERT OR REPLACE INTO post_lifetime (activity_id, impressions, checked_on) VALUES (?, ?, ?)').bind(it.id, it.impressions, body.checked_on),
        ),
      );
    }
    return json(await buildAnalytics(env));
  }
  if (method === 'POST' && pathname === '/api/analytics/import') {
    await importAnalytics(env, await request.json<AnalyticsImport>());
    return json(await buildAnalytics(env));
  }

  if (method === 'POST' && pathname === '/api/oauth/start') {
    if (!env.LI_CLIENT_SECRET) {
      return json({ error: 'Worker secret LI_CLIENT_SECRET is not set. Run: npx wrangler secret put LI_CLIENT_SECRET' }, 400);
    }
    const state = crypto.randomUUID();
    await setSetting(env, 'oauth_state', state + ':' + Date.now());
    const auth = new URL('https://www.linkedin.com/oauth/v2/authorization');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', env.LI_CLIENT_ID);
    auth.searchParams.set('redirect_uri', url.origin + '/oauth/callback');
    auth.searchParams.set('scope', 'openid profile w_member_social');
    auth.searchParams.set('state', state);
    return json({ url: auth.toString() });
  }

  if (method === 'POST' && pathname === '/api/token') {
    const body = await request.json<{ token?: string }>();
    const token = (body.token ?? '').trim();
    if (!token) return json({ error: 'Empty token' }, 400);
    await setSetting(env, 'li_token', await encryptToken(env, token));
    await setSetting(env, 'li_token_saved_at', String(Date.now()));
    await env.DB.prepare("DELETE FROM settings WHERE key = 'li_person_urn'").run();
    return json(await buildState(env));
  }

  if (method === 'POST' && pathname === '/api/token/test') {
    const token = await getLinkedInToken(env);
    if (!token) return json({ ok: false, message: 'No token saved' });
    // hit the API directly — the cached person URN would report "connected"
    // even when the token has expired
    const response = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    if (!response.ok) {
      const hint =
        response.status === 401
          ? ' — invalid or expired. Paste an Access token from Docs and tools → OAuth 2.0 tools (the Client Secret will not work)'
          : '';
      return json({ ok: false, message: 'LinkedIn rejected the token (' + response.status + ')' + hint });
    }
    const body = await response.json<{ sub: string }>();
    const urn = 'urn:li:person:' + body.sub;
    await setSetting(env, 'li_person_urn', urn);
    return json({ ok: true, message: 'Connected — posting as ' + urn });
  }

  return json({ error: 'Not found' }, 404);
}

export function validateMediaSpec(media: MediaSpec | null | undefined): MediaSpec | null {
  if (!media) return null;
  if (!['images', 'document', 'video'].includes(media.kind)) throw new Error('Invalid media kind');
  if (!Array.isArray(media.items) || media.items.length === 0) return null;
  const limit = MEDIA_LIMITS[media.kind];
  if (media.items.length > limit.maxCount) throw new Error(media.kind + ' allows at most ' + limit.maxCount);
  for (const it of media.items) {
    if (typeof it.urn !== 'string' || !it.urn.startsWith('urn:li:')) throw new Error('Invalid media URN');
  }
  return {
    kind: media.kind,
    items: media.items.map((it) => {
      const out: MediaItem = { urn: it.urn, name: String(it.name ?? '').slice(0, 200) };
      if (it.alt) out.alt = String(it.alt).slice(0, 4000);
      // small preview thumbnail generated in the browser; only accept image data URLs
      if (typeof it.thumb === 'string' && it.thumb.startsWith('data:image/') && it.thumb.length <= MAX_THUMB_CHARS) {
        out.thumb = it.thumb;
      }
      return out;
    }),
  };
}

export async function buildState(env: Env) {
  const settings = await getSettings(env);

  const { results } = await env.DB.prepare('SELECT * FROM posts ORDER BY created_at ASC').all<PostRow>();
  const shape = (p: PostRow) => ({
    id: p.id,
    text: p.text,
    status: p.status,
    post_url: p.post_url,
    media: p.media ? (JSON.parse(p.media) as MediaSpec) : null,
    approved_at: p.approved_at,
    queue: p.queue || 'engineers',
    last_error: p.last_error,
    stage: p.stage,
    first_comment: p.first_comment,
    first_comment_status: p.first_comment_status,
  });

  const drafts = results.filter((p) => p.status === 'draft').reverse().map(shape);
  const posted = results.filter((p) => p.status === 'posted').slice(-30).reverse().map(shape);
  const skipped = results.filter((p) => p.status === 'skipped').reverse().map(shape);
  const attention = results.filter((p) => p.status === 'failed' || p.status === 'publishing').map(shape);

  const queues = QUEUES.map((q) => {
    const qs = queueSettings(settings, q.key);
    const rows = results
      .filter((p) => p.status === 'approved' && (p.queue || 'engineers') === q.key)
      .sort((a, b) => (a.approved_at ?? 0) - (b.approved_at ?? 0));
    const lastPostedAt = results.reduce(
      (m, p) => (p.status === 'posted' && (p.queue || 'engineers') === q.key && p.posted_at ? Math.max(m, p.posted_at) : m),
      0,
    );
    const slots = scheduleSlots(qs.post_day, qs.post_hour, qs.cadence_weeks, lastPostedAt, Math.max(rows.length + 1, 4));
    return {
      key: q.key,
      label: q.label,
      settings: qs,
      nextSlotISO: slots[0]?.toISOString() ?? null,
      slots: slots.map((d) => ({ iso: d.toISOString(), label: slotLabel(d, qs.post_hour) })),
      approved: rows.map((p, i) => ({ ...shape(p), planned_slot: slots[i] ? slotLabel(slots[i], qs.post_hour) : 'later' })),
    };
  });

  const savedAt = settings.li_token_saved_at ? Number(settings.li_token_saved_at) : null;
  return {
    settings: {
      min_gap_hours: Number(settings.min_gap_hours),
      stage_target: { tofu: Number(settings.stage_target_tofu), mofu: Number(settings.stage_target_mofu), bofu: Number(settings.stage_target_bofu) },
    },
    queues,
    token: { set: Boolean(settings.li_token), ageDays: savedAt ? Math.floor((Date.now() - savedAt) / 86_400_000) : null },
    maxChars: MAX_POST_CHARS,
    mediaLimits: MEDIA_LIMITS,
    drafts,
    approved: queues.flatMap((q) => q.approved),
    attention,
    posted,
    skipped,
  };
}
