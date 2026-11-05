// Six calendar months, clamping dates such as August 31 to February's final day.
export function sessionExpiry(now: number, remember: boolean): number {
  if (!remember) return now + 12 * 60 * 60 * 1000;
  const expires = new Date(now);
  const day = expires.getUTCDate();
  expires.setUTCDate(1);
  expires.setUTCMonth(expires.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(expires.getUTCFullYear(), expires.getUTCMonth() + 1, 0)).getUTCDate();
  expires.setUTCDate(Math.min(day, lastDay));
  return expires.getTime();
}
