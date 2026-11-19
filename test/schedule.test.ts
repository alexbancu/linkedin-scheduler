import { describe, expect, it } from 'vitest';
import { cadenceGapDays, localDate, scheduleSlots, slotIsOpen, upcomingSlotInstants } from '../src/schedule';

const TUE = 2;
const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe('weekly slots in Europe/Bucharest', () => {
  it('keeps 15:00 local across the October DST change (UTC+3 to UTC+2)', () => {
    // Bucharest leaves summer time on Sunday 25 Oct 2026
    const now = Date.parse('2026-10-19T00:00:00Z');
    expect(iso(upcomingSlotInstants(TUE, 15, 2, now))).toEqual(['2026-10-20T12:00:00.000Z', '2026-10-27T13:00:00.000Z']);
  });

  it('keeps 15:00 local across the March DST change (UTC+2 to UTC+3)', () => {
    // and enters it on Sunday 29 Mar 2026
    const now = Date.parse('2026-03-23T00:00:00Z');
    expect(iso(upcomingSlotInstants(TUE, 15, 2, now))).toEqual(['2026-03-24T13:00:00.000Z', '2026-03-31T12:00:00.000Z']);
  });

  it('still offers a slot whose publish window is open', () => {
    // 16:30 local on the slot day, inside the 2-hour window
    const now = Date.parse('2026-10-20T13:30:00Z');
    expect(upcomingSlotInstants(TUE, 15, 1, now)[0].toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('opens the window at the slot hour and closes it two hours later', () => {
    expect(slotIsOpen(TUE, 15, new Date('2026-10-20T11:59:00Z'))).toBe(false); // 14:59 local
    expect(slotIsOpen(TUE, 15, new Date('2026-10-20T12:00:00Z'))).toBe(true); // 15:00
    expect(slotIsOpen(TUE, 15, new Date('2026-10-20T13:59:00Z'))).toBe(true); // 16:59
    expect(slotIsOpen(TUE, 15, new Date('2026-10-20T14:00:00Z'))).toBe(false); // 17:00
    expect(slotIsOpen(3, 15, new Date('2026-10-20T12:00:00Z'))).toBe(false); // wrong day
  });

  it('uses the local calendar date for the idempotency key', () => {
    // 23:30 UTC on the 19th is already the 20th in Bucharest
    expect(localDate(new Date('2026-10-19T23:30:00Z'))).toBe('2026-10-20');
  });
});

describe('cadence', () => {
  const now = Date.parse('2026-11-02T00:00:00Z'); // a Monday

  it('posts every week when nothing was posted yet', () => {
    expect(iso(scheduleSlots(TUE, 15, 1, 0, 3, now))).toEqual([
      '2026-11-03T13:00:00.000Z',
      '2026-11-10T13:00:00.000Z',
      '2026-11-17T13:00:00.000Z',
    ]);
  });

  it('skips the in-between week on a two-week cadence', () => {
    const lastPosted = Date.parse('2026-10-27T13:00:00Z');
    expect(iso(scheduleSlots(TUE, 15, 2, lastPosted, 2, now))).toEqual(['2026-11-10T13:00:00.000Z', '2026-11-24T13:00:00.000Z']);
  });

  it('keeps every in-between weekly slot blocked', () => {
    for (const weeks of [2, 3, 4]) {
      expect(cadenceGapDays(weeks)).toBeGreaterThan((weeks - 1) * 7);
      expect(cadenceGapDays(weeks)).toBeLessThan(weeks * 7);
    }
  });
});
