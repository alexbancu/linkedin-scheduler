import { QUEUES, queueSettings } from './config';
import { publishToLinkedIn } from './linkedin';
import { markPosted } from './posts';
import { cadenceGapDays, localDate, slotIsOpen } from './schedule';
import { getSettings } from './settings';
import type { PostRow } from './types';

/**
 * Runs every 15 minutes. At most one post per run, across both queues.
 * Guards, in order: the account-wide minimum gap in hours, the queue's own slot
 * window and cadence, then an atomic claim of the slot (queue + Bucharest date)
 * and the post in one D1 batch, so a slot can never publish twice even if cron
 * runs overlap. A failed publish is marked failed and never retried by itself;
 * a missed slot is skipped and the post waits for its queue's next slot.
 */
export async function publishCheck(env: Env, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  const settings = await getSettings(env);
  const minGapH = Number(settings.min_gap_hours);
  const lastAny = await env.DB.prepare("SELECT MAX(posted_at) AS last FROM posts WHERE status = 'posted'").first<{ last: number | null }>();
  if (lastAny?.last && nowMs - lastAny.last < minGapH * 3_600_000) return;

  for (const q of QUEUES) {
    const qs = queueSettings(settings, q.key);
    if (!slotIsOpen(qs.post_day, qs.post_hour, now)) continue;

    const lastQ = await env.DB.prepare("SELECT MAX(posted_at) AS last FROM posts WHERE status = 'posted' AND queue = ?")
      .bind(q.key)
      .first<{ last: number | null }>();
    if (lastQ?.last && nowMs - lastQ.last < cadenceGapDays(qs.cadence_weeks) * 86_400_000) continue;

    const next = await env.DB.prepare("SELECT * FROM posts WHERE status = 'approved' AND queue = ? ORDER BY approved_at ASC LIMIT 1")
      .bind(q.key)
      .first<PostRow>();
    if (!next) continue;

    const slotKey = q.key + ':' + localDate(now);
    const [claim, lock] = await env.DB.batch([
      env.DB.prepare("INSERT INTO slot_runs (slot_key, queue, post_id, status, claimed_at) VALUES (?, ?, ?, 'claimed', ?) ON CONFLICT(slot_key) DO NOTHING")
        .bind(slotKey, q.key, next.id, nowMs),
      env.DB.prepare(
        "UPDATE posts SET status = 'publishing', slot_key = ? WHERE id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM slot_runs WHERE slot_key = ? AND post_id = ?)"
      ).bind(slotKey, next.id, slotKey, next.id),
    ]);
    if (!claim.meta.changes || !lock.meta.changes) continue;

    try {
      const postUrl = await publishToLinkedIn(env, next, false);
      await markPosted(env, next.id, postUrl);
      await env.DB.prepare("UPDATE slot_runs SET status = 'posted', finished_at = ? WHERE slot_key = ?").bind(Date.now(), slotKey).run();
      console.log(JSON.stringify({ event: 'published', queue: q.key, slot: slotKey, id: next.id, url: postUrl }));
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
      await env.DB.batch([
        env.DB.prepare("UPDATE posts SET status = 'failed', last_error = ? WHERE id = ?").bind(msg, next.id),
        env.DB.prepare("UPDATE slot_runs SET status = 'failed', finished_at = ?, error = ? WHERE slot_key = ?").bind(Date.now(), msg, slotKey),
      ]);
      console.error(JSON.stringify({ event: 'publish_failed', queue: q.key, slot: slotKey, id: next.id, error: msg }));
    }
    return;
  }
}
