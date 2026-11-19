import { describe, expect, it } from 'vitest';
import { buildContent, escapeCommentary, formatForLinkedIn, toLiBold } from '../src/format';

describe('formatForLinkedIn', () => {
  it('turns **bold** into Unicode sans-serif bold and leaves other characters alone', () => {
    expect(toLiBold('Ab9')).toBe('𝗔𝗯𝟵');
    expect(toLiBold('ă!')).toBe('ă!');
    expect(formatForLinkedIn('a **big** win')).toBe('a 𝗯𝗶𝗴 win');
  });

  it('turns markdown list markers into bullets', () => {
    expect(formatForLinkedIn('- one\n* two\n  - nested')).toBe('• one\n• two\n  • nested');
  });

  it('does not touch a dash inside a sentence', () => {
    expect(formatForLinkedIn('from 3 - 5 pm')).toBe('from 3 - 5 pm');
  });
});

describe('escapeCommentary', () => {
  it("escapes the Posts API's reserved characters", () => {
    expect(escapeCommentary('#tag @me (x) [y] {z} <a> *b* _c_ ~d~ |e| \\')).toBe(
      '\\#tag \\@me \\(x\\) \\[y\\] \\{z\\} \\<a\\> \\*b\\* \\_c\\_ \\~d\\~ \\|e\\| \\\\',
    );
  });
});

describe('buildContent', () => {
  it('returns nothing for a text-only post', () => {
    expect(buildContent(null)).toBeUndefined();
  });

  it('uses media for one image and multiImage for several', () => {
    expect(buildContent({ kind: 'images', items: [{ urn: 'urn:li:image:1', name: 'a', alt: 'x' }] })).toEqual({
      media: { id: 'urn:li:image:1', altText: 'x' },
    });
    expect(buildContent({ kind: 'images', items: [{ urn: 'urn:li:image:1', name: 'a' }, { urn: 'urn:li:image:2', name: 'b' }] })).toEqual({
      multiImage: { images: [{ id: 'urn:li:image:1', altText: '' }, { id: 'urn:li:image:2', altText: '' }] },
    });
  });

  it('titles a document carousel with its file name', () => {
    expect(buildContent({ kind: 'document', items: [{ urn: 'urn:li:document:9', name: 'Deck.pdf' }] })).toEqual({
      media: { id: 'urn:li:document:9', title: 'Deck.pdf' },
    });
  });
});
