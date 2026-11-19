import { HttpError } from './http';
import { getLinkedInToken } from './crypto';
import { formatForLinkedIn } from './format';
import { getPersonUrn, liHeaders } from './linkedin';
import type { PostRow } from './types';

export async function getPost(env: Env, id: string): Promise<PostRow> {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>();
  if (!post) throw new HttpError(404, 'Post not found');
  return post;
}
export async function markPosted(env: Env, id: string, postUrl: string): Promise<void> {
  await env.DB.prepare("UPDATE posts SET status = 'posted', posted_at = ?, post_url = ? WHERE id = ?")
    .bind(Date.now(), postUrl, id)
    .run();
  // the post is live at this point, so nothing in the comment step may throw back into the publish path
  await postFirstComment(env, id, postUrl).catch((e) => console.error(JSON.stringify({ event: 'first_comment_error', id, error: String(e) })));
}

// Optional first comment (e.g. sources), posted right after the post goes live so
// links stay out of the post body. A failure here never fails the post itself;
// the outcome is kept in first_comment_status ('posted' or 'failed: ...').
export async function postFirstComment(env: Env, id: string, postUrl: string, override?: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT first_comment FROM posts WHERE id = ?').bind(id).first<{ first_comment: string | null }>();
  const text = (override ?? row?.first_comment ?? '').trim();
  if (!text) return null;
  let status = 'posted';
  try {
    const token = await getLinkedInToken(env);
    if (!token) throw new Error('No LinkedIn token saved');
    const actor = await getPersonUrn(env, token);
    const object = postUrl.replace('https://www.linkedin.com/feed/update/', '');
    const body = JSON.stringify({ actor, object, message: { text: formatForLinkedIn(text) } });
    let response = await fetch('https://api.linkedin.com/rest/socialActions/' + encodeURIComponent(object) + '/comments', {
      method: 'POST', headers: liHeaders(token), body,
    });
    // the versioned endpoint wants the Community Management scope (w_member_social_feed);
    // the legacy v2 endpoint accepts plain w_member_social, which this app has
    if (response.status === 403) {
      const { 'LinkedIn-Version': _v, ...v2Headers } = liHeaders(token);
      response = await fetch('https://api.linkedin.com/v2/socialActions/' + encodeURIComponent(object) + '/comments', {
        method: 'POST', headers: v2Headers, body,
      });
    }
    if (response.status !== 201) throw new Error(response.status + ' ' + (await response.text()).slice(0, 300));
    console.log(JSON.stringify({ event: 'first_comment_posted', id }));
  } catch (e) {
    status = 'failed: ' + String(e instanceof Error ? e.message : e).slice(0, 400);
    console.error(JSON.stringify({ event: 'first_comment_failed', id, error: status }));
  }
  await env.DB.prepare('UPDATE posts SET first_comment_status = ? WHERE id = ?').bind(status, id).run();
  return status;
}
export async function moveInQueue(env: Env, id: string, dir: 'up' | 'down'): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, approved_at FROM posts WHERE status = 'approved' AND queue = (SELECT queue FROM posts WHERE id = ?) ORDER BY approved_at ASC"
  ).bind(id).all<{ id: string; approved_at: number }>();
  const idx = results.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= results.length) return;
  const a = results[idx];
  const b = results[swapIdx];
  await env.DB.batch([
    env.DB.prepare('UPDATE posts SET approved_at = ? WHERE id = ?').bind(b.approved_at, a.id),
    env.DB.prepare('UPDATE posts SET approved_at = ? WHERE id = ?').bind(a.approved_at, b.id),
  ]);
}
