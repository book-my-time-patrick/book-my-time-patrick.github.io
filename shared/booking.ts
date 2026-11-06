export const BOOKING_TIMEZONE = 'Asia/Shanghai';
export const REQUEST_DURATIONS = [30, 60, 90, 120] as const;
export const BOOKING_DAY = 86_400_000;
export const REQUEST_HORIZON = 30 * BOOKING_DAY;
const MINUTE = 60_000;
const UTC_OFFSET = 8 * 60 * MINUTE;
const SLOT_STEP = 30 * MINUTE;
const OPEN_MINUTE = 9 * 60;
const CLOSE_MINUTE = 21 * 60;
const WEEK = 7 * BOOKING_DAY;

export type SlotState = 'expired' | 'request' | 'unavailable';

export function bookingDate(timestamp: number): string {
  return new Date(timestamp + UTC_OFFSET).toISOString().slice(0, 10);
}

export function isRequestSlot(startAt: number, duration: number, now: number): boolean {
  if (!Number.isSafeInteger(startAt) || !REQUEST_DURATIONS.some(value => value === duration)) return false;
  if (startAt <= now || startAt > now + REQUEST_HORIZON || startAt % SLOT_STEP !== 0) return false;
  const local = new Date(startAt + UTC_OFFSET);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day >= 1 && day <= 5 && minute >= OPEN_MINUTE && minute + duration <= CLOSE_MINUTE;
}

export function requestWeek(now: number, requestedWeek: number, allowRequests: boolean) {
  const localDay = Math.floor((now + UTC_OFFSET) / BOOKING_DAY) * BOOKING_DAY - UTC_OFFSET;
  const dayOfWeek = new Date(now + UTC_OFFSET).getUTCDay();
  const firstMonday = localDay - ((dayOfWeek + 6) % 7) * BOOKING_DAY;
  const maxWeek = Math.floor((now + REQUEST_HORIZON - firstMonday) / WEEK);
  const week = Math.min(requestedWeek, maxWeek);
  const start = firstMonday + week * WEEK;
  const days = Array.from({ length: 7 }, (_, index) => {
    const midnight = start + index * BOOKING_DAY;
    const slots = Array.from({ length: (CLOSE_MINUTE - OPEN_MINUTE) / 30 }, (_, slotIndex) => {
      const startAt = midnight + OPEN_MINUTE * MINUTE + slotIndex * SLOT_STEP;
      let state: SlotState = 'unavailable';
      if (startAt <= now) state = 'expired';
      else if (allowRequests && isRequestSlot(startAt, 30, now)) state = 'request';
      return { startAt, state };
    });
    return { date: bookingDate(midnight), slots };
  });
  return { now, week, maxWeek, weekStart: bookingDate(start), days, durations: REQUEST_DURATIONS };
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
