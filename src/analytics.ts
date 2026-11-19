import type { MediaSpec } from './types';

// Analytics: LinkedIn's creator analytics export, parsed in the browser
// ---------------------------------------------------------------------

export type AnalyticsImport = {
  file_name?: string;
  range_start: string;
  range_end: string;
  impressions?: number | null;
  members_reached?: number | null;
  followers?: number | null;
  daily?: { date: string; impressions?: number | null; engagements?: number | null }[];
  followers_daily?: { date: string; new_followers: number }[];
  posts?: { id: string; url: string; publish_date?: string | null; impressions?: number | null; engagements?: number | null }[];
  // AUDIENCE DEMOGRAPHICS = followers, CONTENT DEMOGRAPHICS = people who saw posts in the range
  demographics?: { followers?: DemoRow[]; viewers?: DemoRow[] };
};

export type DemoRow = { category: string; label: string; pct: number; lt1?: boolean };
export const DEMO_CATEGORIES = ['Job title', 'Industry', 'Seniority', 'Location', 'Company size', 'Company'];

// Replaces every demographics row of one scope (a whole export sheet, or one post).
export function demoStatements(env: Env, scope: string, scopeId: string, rows: DemoRow[] | undefined): D1PreparedStatement[] {
  const ok = (rows ?? [])
    .filter((r) => DEMO_CATEGORIES.includes(r.category) && typeof r.label === 'string' && r.label.trim() && typeof r.pct === 'number' && r.pct >= 0 && r.pct <= 100)
    .slice(0, 120);
  return [
    env.DB.prepare('DELETE FROM demographics WHERE scope = ? AND scope_id = ?').bind(scope, scopeId),
    ...ok.map((r, i) =>
      env.DB.prepare('INSERT OR REPLACE INTO demographics (scope, scope_id, category, label, pct, lt1, rank) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        scope, scopeId, r.category, r.label.trim().slice(0, 120), r.lt1 ? 0.5 : r.pct, r.lt1 ? 1 : 0, i,
      ),
    ),
  ];
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ACTIVITY_ID = /(\d{19})(?!.*\d{19})/;

export function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

export async function importAnalytics(env: Env, body: AnalyticsImport): Promise<void> {
  if (!ISO_DATE.test(body.range_start ?? '') || !ISO_DATE.test(body.range_end ?? '')) throw new Error('Export date range not found in the file');
  const daily = (body.daily ?? []).filter((d) => ISO_DATE.test(d.date)).slice(0, 400);
  const fdaily = (body.followers_daily ?? []).filter((d) => ISO_DATE.test(d.date)).slice(0, 400);
  const posts = (body.posts ?? []).filter((p) => typeof p.url === 'string' && p.url.startsWith('https://www.linkedin.com/')).slice(0, 100);
  const id = body.range_start + '..' + body.range_end;
  const now = Date.now();

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT OR REPLACE INTO analytics_imports (id, imported_at, range_start, range_end, impressions, members_reached, followers, file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, now, body.range_start, body.range_end, intOrNull(body.impressions), intOrNull(body.members_reached), intOrNull(body.followers), String(body.file_name ?? '').slice(0, 200)),
    env.DB.prepare('DELETE FROM post_metrics WHERE import_id = ?').bind(id),
    ...demoStatements(env, 'followers', id, body.demographics?.followers),
    ...demoStatements(env, 'viewers', id, body.demographics?.viewers),
  ];
  for (const p of posts) {
    const m = p.url.match(ACTIVITY_ID);
    if (!m) continue;
    stmts.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO post_metrics (activity_id, import_id, range_end, post_url, publish_date, impressions, engagements) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(m[1], id, body.range_end, p.url.slice(0, 500), p.publish_date && ISO_DATE.test(p.publish_date) ? p.publish_date : null, intOrNull(p.impressions), intOrNull(p.engagements)),
    );
  }
  for (const d of daily) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO daily_metrics (date, impressions, engagements, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(date) DO UPDATE SET impressions = excluded.impressions, engagements = excluded.engagements, updated_at = excluded.updated_at',
      ).bind(d.date, intOrNull(d.impressions), intOrNull(d.engagements), now),
    );
  }
  for (const d of fdaily) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO daily_metrics (date, new_followers, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(date) DO UPDATE SET new_followers = excluded.new_followers, updated_at = excluded.updated_at',
      ).bind(d.date, intOrNull(d.new_followers), now),
    );
  }
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------
// Per-post page stats: numbers read off each post's own analytics page
// ---------------------------------------------------------------------

export const PAGE_STAT_KEYS = ['impressions', 'profile_viewers', 'followers_gained', 'reactions', 'comments', 'reposts', 'saves', 'sends', 'members_reached', 'in_network_pct'] as const;
export type PageStats = { [K in (typeof PAGE_STAT_KEYS)[number]]: number | null };
// demographics: the post page's "Top demographics", every tab (omit to keep what is stored)
export type PageStatsBody = { checked_on?: string; items?: (Partial<PageStats> & { id: string; demographics?: DemoRow[] })[] };

export async function savePageStats(env: Env, body: PageStatsBody): Promise<void> {
  if (!ISO_DATE.test(body.checked_on ?? '')) throw new Error('checked_on must be YYYY-MM-DD');
  const items = (body.items ?? []).filter((it) => /^\d{19}$/.test(String(it.id))).slice(0, 200);
  if (!items.length) return;
  await env.DB.batch(
    items.flatMap((it) => [
      env.DB.prepare(
        'INSERT OR REPLACE INTO post_page_stats (activity_id, checked_on, ' + PAGE_STAT_KEYS.join(', ') + ') VALUES (?, ?' + ', ?'.repeat(PAGE_STAT_KEYS.length) + ')',
      ).bind(it.id, body.checked_on, ...PAGE_STAT_KEYS.map((k) => intOrNull(it[k]))),
      ...(it.demographics ? demoStatements(env, 'post', it.id, it.demographics) : []),
    ]),
  );
}

export async function buildAnalytics(env: Env) {
  const imports = (
    await env.DB.prepare('SELECT * FROM analytics_imports ORDER BY imported_at DESC LIMIT 20').all<{
      id: string; imported_at: number; range_start: string; range_end: string;
      impressions: number | null; members_reached: number | null; followers: number | null; file_name: string;
    }>()
  ).results;
  const daily = (
    await env.DB.prepare('SELECT date, impressions, engagements, new_followers FROM daily_metrics ORDER BY date DESC LIMIT 366').all<{
      date: string; impressions: number | null; engagements: number | null; new_followers: number | null;
    }>()
  ).results.reverse();
  // The export counts only what happened inside its date range, so a row is the
  // post's lifetime total only when the post was published on or after range_start.
  // Per post: the newest lifetime row; failing that, the newest partial row, flagged.
  const metrics = (
    await env.DB.prepare('SELECT m.*, i.range_start FROM post_metrics m JOIN analytics_imports i ON i.id = m.import_id').all<{
      activity_id: string; range_start: string; range_end: string; post_url: string; publish_date: string | null; impressions: number | null; engagements: number | null;
    }>()
  ).results;
  type Pick = (typeof metrics)[number] & { lifetime: boolean };
  const byId = new Map<string, Pick>();
  for (const m of metrics) {
    const row: Pick = { ...m, lifetime: m.publish_date !== null && m.publish_date >= m.range_start };
    const prev = byId.get(m.activity_id);
    const better =
      !prev ||
      (row.lifetime && !prev.lifetime) ||
      (row.lifetime === prev.lifetime &&
        (row.range_end > prev.range_end ||
          // same end date (e.g. 28-day and 1-year exports on one day): keep the fuller row
          (row.range_end === prev.range_end && (row.impressions ?? -1) + (row.engagements ?? -1) > (prev.impressions ?? -1) + (prev.engagements ?? -1))));
    if (better) byId.set(m.activity_id, row);
  }
  // A number read off the post's own page replaces a partial export count. Its
  // engagements stay unknown: the export's partial count would skew the rate.
  const pageCounts = (
    await env.DB.prepare('SELECT activity_id, impressions, checked_on FROM post_lifetime').all<{ activity_id: string; impressions: number; checked_on: string }>()
  ).results;
  for (const l of pageCounts) {
    const prev = byId.get(l.activity_id);
    if (!prev || (prev.lifetime && prev.range_end >= l.checked_on)) continue;
    byId.set(l.activity_id, { ...prev, impressions: l.impressions, engagements: prev.lifetime ? prev.engagements : null, range_end: l.checked_on, lifetime: true });
  }
  const posted = (
    await env.DB.prepare("SELECT id, text, posted_at, post_url, queue, stage, media FROM posts WHERE status = 'posted' AND post_url IS NOT NULL ORDER BY posted_at DESC").all<{
      id: string; text: string; posted_at: number; post_url: string; queue: string; stage: string | null; media: string | null;
    }>()
  ).results;
  // newest page check per post
  const pageRows = (
    await env.DB.prepare(
      'SELECT s.* FROM post_page_stats s JOIN (SELECT activity_id, MAX(checked_on) AS c FROM post_page_stats GROUP BY activity_id) l ON s.activity_id = l.activity_id AND s.checked_on = l.c',
    ).all<PageStats & { activity_id: string; checked_on: string }>()
  ).results;
  const demoRows = (
    await env.DB.prepare('SELECT scope, scope_id, category, label, pct, lt1 FROM demographics ORDER BY rank').all<{
      scope: string; scope_id: string; category: string; label: string; pct: number; lt1: number;
    }>()
  ).results;
  const demoBy = new Map<string, { category: string; label: string; pct: number; lt1: boolean }[]>();
  for (const d of demoRows) {
    const k = d.scope + ':' + d.scope_id;
    if (!demoBy.has(k)) demoBy.set(k, []);
    demoBy.get(k)!.push({ category: d.category, label: d.label, pct: d.pct, lt1: d.lt1 === 1 });
  }
  // Viewers: the newest export, and of two ending the same day the shorter range
  // (closest to what recent posts did). Followers barely move, so the newest import.
  const withDemo = (scope: string) => imports.filter((i) => demoBy.has(scope + ':' + i.id));
  const pickDemo = (scope: string, better: (a: (typeof imports)[number], b: (typeof imports)[number]) => boolean) => {
    const i = withDemo(scope).reduce<(typeof imports)[number] | null>((m, x) => (!m || better(x, m) ? x : m), null);
    return i ? { range_start: i.range_start, range_end: i.range_end, rows: demoBy.get(scope + ':' + i.id)! } : null;
  };
  const demographics = {
    viewers: pickDemo('viewers', (a, b) => a.range_end > b.range_end || (a.range_end === b.range_end && a.range_start > b.range_start)),
    followers: pickDemo('followers', (a, b) => a.range_end > b.range_end || (a.range_end === b.range_end && a.imported_at > b.imported_at)),
  };
  const pageById = new Map(pageRows.map((r) => [r.activity_id, { ...r, demo: demoBy.get('post:' + r.activity_id) ?? null }]));
  const seen = new Set<string>();
  const latestEnd = imports.reduce((m, i) => (i.range_end > m ? i.range_end : m), '');
  const posts = posted.map((p) => {
    const aid = p.post_url.match(ACTIVITY_ID)?.[1] ?? '';
    seen.add(aid);
    const m = byId.get(aid);
    return {
      id: p.id, text: p.text, posted_at: p.posted_at, post_url: p.post_url, queue: p.queue || 'engineers', stage: p.stage,
      // only the kind: the stored media JSON carries preview thumbnails
      media_kind: p.media ? (JSON.parse(p.media) as MediaSpec).kind : 'text',
      // posts published after the newest export cannot be in it yet
      too_new: !m && latestEnd !== '' && new Date(p.posted_at).toISOString().slice(0, 10) > latestEnd,
      metrics: m ? { impressions: m.impressions, engagements: m.engagements, as_of: m.range_end, lifetime: m.lifetime, from: m.range_start } : null,
      activity_id: aid,
      page: pageById.get(aid) ?? null,
    };
  });
  const other = [...byId.values()]
    .filter((m) => !seen.has(m.activity_id))
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .map((m) => ({
      post_url: m.post_url, publish_date: m.publish_date, impressions: m.impressions, engagements: m.engagements, as_of: m.range_end, lifetime: m.lifetime, from: m.range_start,
      activity_id: m.activity_id, page: pageById.get(m.activity_id) ?? null,
    }));
  return { imports, demographics, latest: imports.slice().sort((a, b) => (a.range_end < b.range_end ? 1 : a.range_end > b.range_end ? -1 : b.imported_at - a.imported_at))[0] ?? null, daily, posts, other };
}
