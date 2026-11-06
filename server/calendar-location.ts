import type { Context, Hono } from 'hono';
import { BOOKING_DAY, bookingDate, REQUEST_HORIZON } from '../shared/booking.js';
import { AuthError, requireAdmin } from './auth.js';
import type { Environment } from './db.js';

type Ctx = Context<{ Bindings: Environment }>;
type DateCity = { date: string; city: string };

function database(c: Ctx) {
  if (!c.env.DB) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return c.env.DB;
}

function locationWindow(now: number) {
  return { today: bookingDate(now), lastDate: bookingDate(now + REQUEST_HORIZON) };
}

function dateTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AuthError(400, 'INVALID_DATE_RANGE');
  }
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp) || bookingDate(timestamp) !== value) throw new AuthError(400, 'INVALID_DATE_RANGE');
  return timestamp;
}

function readCity(value: unknown, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 96 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new AuthError(400, 'INVALID_CITY');
  }
  const city = value.normalize('NFC').trim().replace(/ +/g, ' ');
  if (!city && allowEmpty) return city;
  if ([...city].length > 24 || !/^\p{L}[\p{L}\p{M}]*(?:[ -]\p{L}[\p{L}\p{M}]*)*$/u.test(city)) {
    throw new AuthError(400, 'INVALID_CITY');
  }
  return city;
}

async function inputObject(c: Ctx) {
  if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(400, 'INVALID_INPUT');
  }
  const input: unknown = await c.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuthError(400, 'INVALID_INPUT');
  return input as Record<string, unknown>;
}

async function readLocations(c: Ctx, from: string, through: string) {
  const db = database(c);
  const [setting, overrides] = await Promise.all([
    db.prepare('SELECT default_city FROM calendar_location_settings WHERE id=1').first<{ default_city: string }>(),
    db.prepare('SELECT date_key AS date,city FROM calendar_location_dates WHERE date_key BETWEEN ? AND ? ORDER BY date_key')
      .bind(from, through).all<DateCity>(),
  ]);
  return { defaultCity: setting?.default_city ?? '', dates: overrides.results };
}

export async function withCalendarCities<T extends { date: string }>(c: Ctx, days: T[], now: number) {
  const { today, lastDate } = locationWindow(now);
  const eligible = days.filter(day => day.date >= today && day.date <= lastDate);
  if (!eligible.length) return days;
  const locations = await readLocations(c, eligible[0].date, eligible[eligible.length - 1].date);
  const cities = new Map(locations.dates.map(({ date, city }) => [date, city]));
  return days.map(day => {
    if (day.date < today || day.date > lastDate) return day;
    const city = cities.get(day.date) ?? locations.defaultCity;
    return city ? { ...day, city } : day;
  });
}

export function mountCalendarLocation(app: Hono<{ Bindings: Environment }>) {
  app.get('/api/admin/calendar-location', adminOnly, async c => {
    const { today, lastDate } = locationWindow(Date.now());
    return c.json(await readLocations(c, today, lastDate));
  });

  app.patch('/api/admin/calendar-location', adminOnly, async c => {
    const city = readCity((await inputObject(c)).defaultCity, true);
    await database(c).prepare(`INSERT INTO calendar_location_settings(id,default_city) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET default_city=excluded.default_city`).bind(city).run();
    return c.json({ ok: true });
  });

  app.post('/api/admin/calendar-location/dates', adminOnly, async c => {
    const input = await inputObject(c);
    const from = dateTimestamp(input.startDate);
    const through = dateTimestamp(input.endDate);
    const { today, lastDate } = locationWindow(Date.now());
    if (from > through || bookingDate(from) < today || bookingDate(through) > lastDate) {
      throw new AuthError(400, 'INVALID_DATE_RANGE');
    }
    const city = readCity(input.city);
    const dates = Array.from({ length: (through - from) / BOOKING_DAY + 1 }, (_, index) => bookingDate(from + index * BOOKING_DAY));
    await database(c).prepare(`INSERT INTO calendar_location_dates(date_key,city)
      VALUES ${dates.map(() => '(?,?)').join(',')}
      ON CONFLICT(date_key) DO UPDATE SET city=excluded.city`).bind(...dates.flatMap(date => [date, city])).run();
    return c.json({ ok: true });
  });

  app.delete('/api/admin/calendar-location/dates/:date', adminOnly, async c => {
    const date = bookingDate(dateTimestamp(c.req.param('date')));
    await database(c).prepare('DELETE FROM calendar_location_dates WHERE date_key=?').bind(date).run();
    return c.json({ ok: true });
  });
}

async function adminOnly(c: Ctx, next: () => Promise<void>) {
  if (!await requireAdmin(c)) throw new AuthError(401, 'UNAUTHENTICATED');
  await next();
}
