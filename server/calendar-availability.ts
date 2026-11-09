import { REQUEST_HORIZON } from '../shared/booking.js';
import type { SqlDatabase } from './db.js';

export const CALENDAR_FRESH_MS = 10 * 60_000;
export const CALENDAR_WINDOW_MS = REQUEST_HORIZON + 120 * 60_000;

export type BusyRange = [number, number];
export type BusySnapshot = {
  coveredFrom: number;
  coveredUntil: number;
  validUntil: number;
  busy: BusyRange[];
};

export function mergeBusyRanges(ranges: BusyRange[]): BusyRange[] {
  const merged: BusyRange[] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export async function readAvailability(db: SqlDatabase, now: number) {
  const rows = await db.prepare(`SELECT settings.direct_enabled,
      sources.covered_from, sources.covered_until, sources.synced_at, sources.busy_json
    FROM calendar_settings settings
    LEFT JOIN calendar_sources sources ON sources.synced_at>? AND sources.synced_at<=?
      AND sources.covered_from<=? AND sources.covered_until>=? AND sources.last_error IS NULL
    WHERE settings.id=1`).bind(now - CALENDAR_FRESH_MS, now, now, now + CALENDAR_WINDOW_MS).all<{
      direct_enabled: number; covered_from: number | null; covered_until: number | null; synced_at: number | null; busy_json: string | null;
    }>();
  const directEnabled = rows.results[0]?.direct_enabled === 1;
  if (rows.results.length !== 2) return { directEnabled, snapshot: null };
  const coveredUntil = Math.min(...rows.results.map(row => row.covered_until!));
  const snapshot: BusySnapshot = {
    coveredFrom: Math.max(...rows.results.map(row => row.covered_from!)),
    coveredUntil,
    validUntil: Math.min(coveredUntil - CALENDAR_WINDOW_MS, ...rows.results.map(row => row.synced_at! + CALENDAR_FRESH_MS)),
    busy: mergeBusyRanges(rows.results.flatMap(row => JSON.parse(row.busy_json!) as BusyRange[])),
  };
  return { directEnabled, snapshot };
}
