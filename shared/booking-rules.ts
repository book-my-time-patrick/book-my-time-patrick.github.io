export type Hours = [number, number];
export interface BookingRules {
  timeZone: string;
  weeklyHours: Hours[][];
  blockedDates: string[];
  leadMinutes: number;
  horizonDays: number;
  durations: number[];
  stepMinutes: 15 | 30;
  bufferBefore: number;
  bufferAfter: number;
  dailyLimit: number;
  weeklyLimit: number;
}
export const MAX_BOOKING_DAYS = 44;
export const MAX_BUFFER = 120;
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const DEFAULT_RULES: BookingRules = {
  timeZone: 'Asia/Shanghai', weeklyHours: [[], [[540, 1260]], [[540, 1260]], [[540, 1260]], [[540, 1260]], [[540, 1260]], []],
  blockedDates: [], leadMinutes: 0, horizonDays: 30, durations: [30, 60, 90, 120], stepMinutes: 30,
  bufferBefore: 0, bufferAfter: 0, dailyLimit: 0, weeklyLimit: 0,
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(zone, value);
  }
  return value;
}
export function validZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80 || !/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try { formatter(value); return true; } catch { return false; }
}
function wall(at: number, zone: string) {
  if (zone === DEFAULT_RULES.timeZone) return new Date(at + 480 * MINUTE).toISOString().slice(0, 16);
  const parts = Object.fromEntries(formatter(zone).formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function ruleDate(at: number, zone: string) { return wall(at, zone).slice(0, 10); }
export function ruleClock(at: number, zone: string) { return wall(at, zone).slice(11, 16); }
export function minuteOf(clock: string) { const [h, m] = clock.split(':').map(Number); return h * 60 + m; }
export function clockOf(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
export function shiftDate(date: string, days: number) { return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10); }
export function mondayOf(date: string) { return shiftDate(date, -((new Date(date).getUTCDay() + 6) % 7)); }

const offsets = new Map<string, number[]>();
export function ruleTimestamp(date: string, minute: number, zone: string): number {
  const midnight = Date.parse(date);
  if (!Number.isFinite(midnight) || !Number.isInteger(minute) || minute < 0 || minute > 1440) return NaN;
  if (minute === 1440) return ruleTimestamp(shiftDate(date, 1), 0, zone);
  const at = midnight + minute * MINUTE;
  if (zone === DEFAULT_RULES.timeZone) return at - 480 * MINUTE;
  const key = `${zone}/${date}`;
  let choices = offsets.get(key);
  if (!choices) {
    choices = [...new Set([-1, 0, 1, 2].map(day => {
      const sample = midnight + day * DAY;
      return Date.parse(`${wall(sample, zone)}:00Z`) - sample;
    }))].sort((a, b) => b - a);
    if (offsets.size >= 128) offsets.clear();
    offsets.set(key, choices);
  }
  if (choices.length === 1) return at - choices[0];
  // On clock changes use the first occurrence and omit nonexistent wall times.
  return choices.map(offset => at - offset).find(candidate => wall(candidate, zone) === `${date}T${clockOf(minute)}`) ?? NaN;
}
export function dayStart(date: string, zone: string): number {
  for (let minute = 0; minute < 1440; minute += 15) {
    const value = ruleTimestamp(date, minute, zone);
    if (Number.isFinite(value)) return value;
  }
  return dayStart(shiftDate(date, 1), zone);
}
export function expired(at: number, now: number, lead: number) { return at <= now || at < now + lead * MINUTE; }
export function lengthsAtWallTime(at: number, date: string, minute: number, now: number, rules: BookingRules, checkLead = true) {
  if (expired(at, now, checkLead ? rules.leadMinutes : 0) || at > now + rules.horizonDays * DAY
    || rules.blockedDates.includes(date) || minute % rules.stepMinutes) return [];
  return rules.durations.filter(length => rules.weeklyHours[new Date(date).getUTCDay()].some(([start, end]) =>
    start <= minute && minute + length <= end) && ruleTimestamp(date, minute + length, rules.timeZone) === at + length * MINUTE);
}

export function lengthsFor(at: number, now: number, rules: BookingRules, checkLead = true) {
  if (!Number.isSafeInteger(at) || at <= now || at > now + rules.horizonDays * DAY) return [];
  const date = ruleDate(at, rules.timeZone);
  const minute = minuteOf(ruleClock(at, rules.timeZone));
  if (ruleTimestamp(date, minute, rules.timeZone) !== at) return [];
  return lengthsAtWallTime(at, date, minute, now, rules, checkLead);
}
