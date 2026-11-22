import { DAY, MINUTE, DEFAULT_RULES, dayStart, expired, lengthsAtWallTime, lengthsFor, mondayOf, ruleDate, ruleClock, ruleTimestamp, minuteOf, shiftDate } from './booking-rules.js';
import type { BookingRules } from './booking-rules.js';
export const BOOKING_TIMEZONE = 'Asia/Shanghai';
export const REQUEST_DURATIONS = [30, 60, 90, 120] as const;
export const BOOKING_DAY = 86_400_000;
export const REQUEST_HORIZON = 30 * BOOKING_DAY;
const UTC_OFFSET = 8 * 60 * MINUTE;

export type SlotState = 'expired' | 'request' | 'unavailable';

export function bookingDate(timestamp: number): string {
  return new Date(timestamp + UTC_OFFSET).toISOString().slice(0, 10);
}

export function isRequestSlot(at: number, duration: number, now: number, rules = DEFAULT_RULES, checkLead = true) {
  return lengthsFor(at, now, rules, checkLead).includes(duration);
}

export function weekBounds(now: number, requested: number, rules: BookingRules, allowOpen: boolean) {
  const zone = rules.timeZone;
  const monday = mondayOf(ruleDate(now, zone));
  const horizon = Math.max(rules.horizonDays, allowOpen ? 30 : 0) * DAY;
  const maxWeek = (Date.parse(mondayOf(ruleDate(now + horizon, zone))) - Date.parse(monday)) / (7 * DAY);
  const week = Math.max(0, Math.min(requested, maxWeek));
  const weekStart = shiftDate(monday, week * 7);
  return { week, maxWeek, weekStart, from: dayStart(weekStart, zone), through: dayStart(shiftDate(weekStart, 7), zone) };
}

export function requestWeek(now: number, requested: number, allowRequests: boolean, rules = DEFAULT_RULES,
  allowOpen = false, sessions: { startAt: number; endAt: number }[] = []) {
  const { week, maxWeek, weekStart } = weekBounds(now, requested, rules, allowOpen);
  const { timeZone, stepMinutes, leadMinutes } = rules;
  let start = 540;
  let end = 1260;
  for (const [from, through] of rules.weeklyHours.flat()) { start = Math.min(start, from); end = Math.max(end, through); }
  for (const session of sessions) {
    const last = session.endAt - MINUTE;
    if (ruleDate(session.startAt, timeZone) !== ruleDate(last, timeZone)) { start = 0; end = 1440; continue; }
    start = Math.min(start, minuteOf(ruleClock(session.startAt, timeZone)));
    end = Math.max(end, minuteOf(ruleClock(last, timeZone)) + 1);
  }
  start = Math.floor(start / stepMinutes) * stepMinutes;
  end = Math.ceil(end / stepMinutes) * stepMinutes;
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(weekStart, index);
    const slots: { startAt: number; localMinute: number; state: SlotState; requestDurations?: number[] }[] = [];
    for (let minute = start; minute < end; minute += stepMinutes) {
      const startAt = ruleTimestamp(date, minute, timeZone);
      if (!Number.isFinite(startAt)) continue;
      const lengths = allowRequests ? lengthsAtWallTime(startAt, date, minute, now, rules) : [];
      const state: SlotState = expired(startAt, now, leadMinutes) ? 'expired' : lengths.length ? 'request' : 'unavailable';
      slots.push({ startAt, localMinute: minute, state, ...(lengths.length ? { requestDurations: lengths } : {}) });
    }
    return { date, slots };
  });
  return { now, week, maxWeek, weekStart, days, durations: rules.durations, grid: { start, end, timeZone, stepMinutes, leadMinutes } };
}

// Accept a bare address rather than a display name or a list of recipients.
export function parseEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 254 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const address = value.trim();
  const parts = address.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return null;
  return `${local}@${domain.toLowerCase()}`;
}
