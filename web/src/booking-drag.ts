// Pure range logic for drag-selecting time on the booking calendar. No DOM access.

/** One grid row of a single day column, in ascending time order. */
export interface DragRow {
  startAt: number;
  /** The slot can be chosen as part of a booking. */
  selectable: boolean;
  /** Durations (minutes) the server accepts when a booking starts at this row. */
  durations: readonly number[];
}

export interface DragRange {
  /** Index of the first row of the range. */
  index: number;
  /** Length in minutes. */
  duration: number;
}

/**
 * Resolve the range a drag gesture should select.
 *
 * The result always includes the anchor row and is the range closest to the pointer
 * that (a) only covers selectable rows and (b) has a duration the server allows for
 * its start row. If the pointer is farther than allowed, the range is clamped
 * toward the anchor. Until the pointer has moved (`moved` false), or when nothing is
 * valid, it falls back to the anchor row alone using `preferred` (or the shortest
 * allowed duration), which matches a plain click. Once moved, returning to the anchor
 * row selects exactly one row.
 */
export function resolveDrag(
  rows: readonly (DragRow | undefined)[],
  anchor: number,
  pointer: number,
  stepMinutes: number,
  preferred: number,
  moved: boolean,
): DragRange | undefined {
  const anchorRow = rows[anchor];
  if (!anchorRow?.selectable) return undefined;
  const direction = pointer >= anchor ? 1 : -1;
  for (let p = moved || pointer !== anchor ? pointer : NaN; direction > 0 ? p >= anchor : p <= anchor; p -= direction) {
    const low = Math.min(p, anchor);
    const high = Math.max(p, anchor);
    const first = rows[low];
    if (!first?.selectable || !rows[high]?.selectable) continue;
    let contiguous = true;
    for (let i = low; i <= high && contiguous; i++) contiguous = Boolean(rows[i]?.selectable);
    if (!contiguous) continue;
    const duration = (high - low + 1) * stepMinutes;
    if (first.durations.includes(duration)) return { index: low, duration };
  }
  const allowed = anchorRow.durations;
  if (!allowed.length) return undefined;
  return { index: anchor, duration: allowed.includes(preferred) ? preferred : Math.min(...allowed) };
}

/** Row indexes covered by a resolved range. */
export function rangeRows(range: DragRange, stepMinutes: number): number[] {
  const count = Math.max(1, Math.round(range.duration / stepMinutes));
  return Array.from({ length: count }, (_, offset) => range.index + offset);
}

/** Pick the row whose vertical extent contains `y`, clamping to the first/last row. */
export function rowAtY(tops: readonly number[], bottoms: readonly number[], y: number): number {
  if (!tops.length) return -1;
  if (y <= tops[0]) return 0;
  const last = tops.length - 1;
  if (y >= bottoms[last]) return last;
  for (let i = 0; i <= last; i++) if (y >= tops[i] && y < bottoms[i]) return i;
  // In a gap between rows: choose the nearer one.
  for (let i = 0; i < last; i++) if (y >= bottoms[i] && y < tops[i + 1]) return y - bottoms[i] < tops[i + 1] - y ? i : i + 1;
  return last;
}
