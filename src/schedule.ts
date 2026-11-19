import { PUBLISH_WINDOW_H, TZ } from './config';

/**
 * Weekly slot math in the configured time zone (Europe/Bucharest by default).
 * Everything here is pure: `now` is passed in, so the DST edges are unit tested.
 */

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function parts(date: Date, opts: Intl.DateTimeFormatOptions, locale = 'en-US'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Weekday (0 = Sunday) and hour of `date` in the slot time zone. */
export function tzParts(date: Date): { dow: number; hour: number } {
  const p = parts(date, { weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  return { dow: DAY_INDEX[p.weekday], hour: Number(p.hour) };
}

/** Offset of the slot time zone from UTC at `date`, in ms (+2h or +3h for Bucharest). */
export function tzOffsetMs(date: Date): number {
  const p = parts(date, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}

/** True while `now` is inside the publish window that starts at the slot hour. */
export function slotIsOpen(postDay: number, postHour: number, now: Date = new Date()): boolean {
  const t = tzParts(now);
  return t.dow === postDay && t.hour >= postHour && t.hour < postHour + PUBLISH_WINDOW_H;
}

/** The next `count` weekly slot instants for a day and local hour, DST-aware. */
export function upcomingSlotInstants(postDay: number, postHour: number, count: number, now = Date.now()): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < 7 * (count + 2) && out.length < count; i++) {
    const p = parts(new Date(now + i * DAY_MS), { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA');
    if (DAY_INDEX[p.weekday] !== postDay) continue;
    // local wall-clock time read as UTC, then corrected by that day's offset
    const guess = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, postHour, 0, 0));
    const instant = new Date(guess.getTime() - tzOffsetMs(guess));
    if (instant.getTime() < now - PUBLISH_WINDOW_H * HOUR_MS) continue;
    out.push(instant);
  }
  return out;
}

/**
 * Minimum days since the last post before the next slot is eligible.
 * The -2 buffer absorbs the publish window and DST drift so a slot is never
 * missed by minutes, while in-between weekly slots stay blocked
 * (cadence 2: 7 < 12; cadence 4: 21 < 26).
 */
export function cadenceGapDays(cadenceWeeks: number): number {
  return cadenceWeeks * 7 - 2;
}

/**
 * Slots the queue will actually use: weekly slots thinned to the cadence and
 * anchored on the last post (the first slot past the cadence gap, then every
 * cadence-th weekly slot after it).
 */
export function scheduleSlots(postDay: number, postHour: number, cadenceWeeks: number, lastPostedAt: number, count: number, now = Date.now()): Date[] {
  const weekly = upcomingSlotInstants(postDay, postHour, count * cadenceWeeks + 2, now);
  let start = 0;
  if (lastPostedAt) {
    const eligibleFrom = lastPostedAt + cadenceGapDays(cadenceWeeks) * DAY_MS;
    start = weekly.findIndex((d) => d.getTime() >= eligibleFrom);
    if (start === -1) start = weekly.length;
  }
  const out: Date[] = [];
  for (let k = start; k < weekly.length && out.length < count; k += cadenceWeeks) out.push(weekly[k]);
  return out;
}

export function slotLabel(instant: Date, postHour: number): string {
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(instant);
  return label + ', ' + String(postHour).padStart(2, '0') + ':00';
}

/** Calendar date in the slot time zone, YYYY-MM-DD; part of each slot's idempotency key. */
export function localDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
