import type { MediaSpec, SettingsMap } from './types';

export const MAX_THUMB_CHARS = 160_000; // ~120KB data URL — client-generated preview thumbnail (up to ~720px)

// Each queue owns one weekly slot (category-based scheduling, as in SocialBee or
// Hypefury). Engineers keeps the original un-prefixed setting keys so the settings
// saved before the second queue existed carry over unchanged.
export type QueueKey = 'engineers' | 'gtm';
export const QUEUES: { key: QueueKey; label: string; defaults: { post_day: string; post_hour: string; cadence_weeks: string } }[] = [
  { key: 'engineers', label: 'Engineers', defaults: { post_day: '2', post_hour: '15', cadence_weeks: '1' } },
  { key: 'gtm', label: 'GTM leaders', defaults: { post_day: '4', post_hour: '15', cadence_weeks: '1' } },
];
// Optional funnel stage per post: tofu (reach), mofu (trust), bofu (ask).
export const STAGES = ['tofu', 'mofu', 'bofu'] as const;
export type Stage = (typeof STAGES)[number];
export function isStage(x: unknown): x is Stage {
  return typeof x === 'string' && (STAGES as readonly string[]).includes(x);
}
export function isQueue(q: unknown): q is QueueKey {
  return q === 'engineers' || q === 'gtm';
}
export function qKey(q: QueueKey, name: string): string {
  return q === 'engineers' ? name : q + '.' + name;
}
export function queueSettings(settings: SettingsMap, q: QueueKey): { post_day: number; post_hour: number; cadence_weeks: number } {
  const def = QUEUES.find((x) => x.key === q)!.defaults;
  const get = (n: 'post_day' | 'post_hour' | 'cadence_weeks') => settings[qKey(q, n)] ?? def[n];
  return { post_day: Number(get('post_day')), post_hour: Number(get('post_hour')), cadence_weeks: Math.max(1, Number(get('cadence_weeks')) || 1) };
}

export const TZ = 'Europe/Bucharest';
export const PUBLISH_WINDOW_H = 2;
export const LINKEDIN_VERSION = '202606'; // versioned LinkedIn API (YYYYMM); bump periodically
export const MAX_POST_CHARS = 3000;
export const MAX_COMMENT_CHARS = 1250; // LinkedIn's comment limit

export const MB = 1024 * 1024;
export const MEDIA_LIMITS: Record<MediaSpec['kind'], { mimes: string[]; maxBytes: number; maxCount: number; label: string }> = {
  images: {
    mimes: ['image/jpeg', 'image/png', 'image/gif'],
    maxBytes: 15 * MB,
    maxCount: 20,
    label: 'JPG/PNG/GIF up to 15MB each, up to 20',
  },
  document: {
    mimes: [
      'application/pdf',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maxBytes: 100 * MB,
    maxCount: 1,
    label: 'PDF/PPT/DOC up to 100MB, 300 pages',
  },
  video: { mimes: ['video/mp4'], maxBytes: 95 * MB, maxCount: 1, label: 'MP4 up to ~95MB' },
};

// min_gap_hours is account-wide, across both queues. Two posts within about 18 hours
// cut each other's reach (van der Blom); 24 hours covers that with a margin.
// stage_target_*: the funnel mix to aim for per 8 posts (content strategy: 3 TOFU, 4 MOFU, 1 BOFU).
export const DEFAULTS: SettingsMap = {
  post_day: '2', post_hour: '15', cadence_weeks: '1', min_gap_hours: '24',
  stage_target_tofu: '3', stage_target_mofu: '4', stage_target_bofu: '1',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Scripts only from this origin (no inline script). Inline styles stay allowed:
  // the dashboard sets element styles, and a style cannot run code.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    // licdn.com: video cover and processed MP4 read back from LinkedIn for the preview
    "img-src 'self' data: blob: https://*.licdn.com; media-src 'self' blob: https://*.licdn.com; " +
    "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
