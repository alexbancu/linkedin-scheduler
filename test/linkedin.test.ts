import { describe, expect, it } from 'vitest';
import { licdnUrl, linkedInUploadUrl } from '../src/linkedin';

describe('URLs that come back from LinkedIn', () => {
  it('sends the token only to https linkedin.com upload hosts', () => {
    expect(linkedInUploadUrl('https://www.linkedin.com/dms-uploads/abc')).toBe('https://www.linkedin.com/dms-uploads/abc');
    expect(() => linkedInUploadUrl('https://evil.example/upload')).toThrow(/outside linkedin.com/);
    expect(() => linkedInUploadUrl('https://linkedin.com.evil.example/x')).toThrow();
    expect(() => linkedInUploadUrl('http://www.linkedin.com/x')).toThrow();
  });

  it('hands only licdn.com media URLs to the page', () => {
    expect(licdnUrl('https://media.licdn.com/v.mp4')).toBe('https://media.licdn.com/v.mp4');
    expect(licdnUrl('https://evil.example/v.mp4')).toBeNull();
    expect(licdnUrl('javascript:alert(1)')).toBeNull();
  });
});
