import type { MediaSpec } from './types';

// The Posts API "commentary" field treats these characters as reserved markup.
export function escapeCommentary(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (m) => '\\' + m);
}

// LinkedIn has no rich text: "bold" is done with Unicode Mathematical
// Sans-Serif Bold codepoints. Only A-Z, a-z, 0-9 have bold variants;
// everything else (diacritics, punctuation) passes through unchanged.
export function toLiBold(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 65 && cp <= 90) out += String.fromCodePoint(0x1d5d4 + cp - 65);
    else if (cp >= 97 && cp <= 122) out += String.fromCodePoint(0x1d5ee + cp - 97);
    else if (cp >= 48 && cp <= 57) out += String.fromCodePoint(0x1d7ec + cp - 48);
    else out += ch;
  }
  return out;
}

// Drafts stay editable markdown-ish; this runs at publish time (and mirrored
// client-side for the preview): **bold** → unicode bold, "* " / "- " → "• ".
export function formatForLinkedIn(text: string): string {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, (_, inner: string) => toLiBold(inner))
    .replace(/^([ \t]*)[*-][ \t]+/gm, '$1• ');
}

export function buildContent(media: MediaSpec | null): Record<string, unknown> | undefined {
  if (!media || media.items.length === 0) return undefined;
  if (media.kind === 'images') {
    if (media.items.length === 1) return { media: { id: media.items[0].urn, altText: media.items[0].alt ?? '' } };
    return { multiImage: { images: media.items.map((it) => ({ id: it.urn, altText: it.alt ?? '' })) } };
  }
  // document (carousel) and video both use content.media { id, title }
  return { media: { id: media.items[0].urn, title: media.items[0].name || (media.kind === 'video' ? 'Video' : 'Document') } };
}
