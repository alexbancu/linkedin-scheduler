-- Initial schema. Apply with: npx wrangler d1 migrations apply linkedin-scheduler --local (or --remote)

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | approved | posted | skipped
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  posted_at INTEGER,
  post_url TEXT,
  queue TEXT NOT NULL DEFAULT 'engineers', -- engineers | gtm
  slot_key TEXT,
  stage TEXT, -- tofu | mofu | bofu | NULL (optional funnel stage)
  last_error TEXT,
  media TEXT, -- JSON: {kind:'images'|'document'|'video', items:[{urn,name,alt}]} — LinkedIn asset URNs
  first_comment TEXT, -- optional comment posted right after publish (sources, links)
  first_comment_status TEXT -- posted | failed: <reason> | NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slot_runs (
  slot_key TEXT PRIMARY KEY, -- queue:YYYY-MM-DD (Bucharest)
  queue TEXT NOT NULL,
  post_id TEXT NOT NULL,
  status TEXT NOT NULL, -- claimed | posted | failed
  claimed_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_queue_status ON posts (queue, status);

-- Post analytics imported from LinkedIn's creator analytics export (.xlsx).
-- One row per export file; a re-import of the same date range replaces it.
CREATE TABLE IF NOT EXISTS analytics_imports (
  id TEXT PRIMARY KEY, -- range_start..range_end (YYYY-MM-DD)
  imported_at INTEGER NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  impressions INTEGER,
  members_reached INTEGER,
  followers INTEGER,
  file_name TEXT
);

-- Per-post numbers as of an import, keyed on the 19-digit post ID that both the
-- export URLs and posts.post_url (urn:li:share:<id>) contain.
CREATE TABLE IF NOT EXISTS post_metrics (
  activity_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  range_end TEXT NOT NULL,
  post_url TEXT NOT NULL,
  publish_date TEXT,
  impressions INTEGER,
  engagements INTEGER,
  PRIMARY KEY (activity_id, import_id)
);
CREATE INDEX IF NOT EXISTS idx_post_metrics_activity ON post_metrics (activity_id, range_end);

-- Account-level daily series; later imports overwrite overlapping days.
CREATE TABLE IF NOT EXISTS daily_metrics (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD (UTC, as LinkedIn records it)
  impressions INTEGER,
  engagements INTEGER,
  new_followers INTEGER,
  updated_at INTEGER NOT NULL
);

-- Lifetime impressions read off a post's own LinkedIn page. Used for posts
-- published before every export's date range, where the export only has a
-- partial count. Keyed on the same 19-digit post ID as post_metrics.
CREATE TABLE IF NOT EXISTS post_lifetime (
  activity_id TEXT PRIMARY KEY,
  impressions INTEGER NOT NULL,
  checked_on TEXT NOT NULL -- YYYY-MM-DD
);

-- Numbers read off a post's own analytics page (linkedin.com/analytics/post-summary/...).
-- The export has none of these except impressions. One row per post per check day.
CREATE TABLE IF NOT EXISTS post_page_stats (
  activity_id TEXT NOT NULL, -- same 19-digit post ID as post_metrics
  checked_on TEXT NOT NULL, -- YYYY-MM-DD
  impressions INTEGER,
  profile_viewers INTEGER, -- "Profile viewers from this post"
  followers_gained INTEGER, -- "Followers gained from this post"
  reactions INTEGER,
  comments INTEGER,
  reposts INTEGER,
  saves INTEGER,
  sends INTEGER,
  members_reached INTEGER,
  in_network_pct INTEGER, -- "In-network (followers and connections)"
  PRIMARY KEY (activity_id, checked_on)
);

-- "Top demographics" percentages, as LinkedIn lists them (top ~10 per category).
-- scope = followers | viewers (scope_id = analytics_imports.id, from the export's
-- AUDIENCE and CONTENT DEMOGRAPHICS sheets) or post (scope_id = 19-digit post ID,
-- read off the post's own analytics page; only its newest check is kept).
CREATE TABLE IF NOT EXISTS demographics (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  category TEXT NOT NULL, -- Job title | Industry | Seniority | Location | Company size | Company
  label TEXT NOT NULL,
  pct REAL NOT NULL, -- 0-100; LinkedIn's "< 1%" is stored as 0.5 with lt1 = 1
  lt1 INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL, -- order LinkedIn listed it in
  PRIMARY KEY (scope, scope_id, category, label)
);
