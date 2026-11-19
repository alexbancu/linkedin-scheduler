export type MediaItem = { urn: string; name: string; alt?: string; thumb?: string };
export type MediaSpec = { kind: 'images' | 'document' | 'video'; items: MediaItem[] };

export type PostRow = {
  id: string;
  text: string;
  status: string;
  created_at: number;
  approved_at: number | null;
  posted_at: number | null;
  post_url: string | null;
  media: string | null;
  queue: string;
  slot_key: string | null;
  last_error: string | null;
  stage: string | null;
  first_comment: string | null;
  first_comment_status: string | null;
};

export type SettingsMap = Record<string, string>;
