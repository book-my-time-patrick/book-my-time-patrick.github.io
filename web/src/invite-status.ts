export type InviteState = 'active' | 'expiring' | 'expired' | 'revoked';

const expiringWindow = 3 * 86_400_000;

export function inviteStatus(expiresAt: number, revoked: boolean, now: number): { state: InviteState; nextAt: number | null } {
  if (revoked) return { state: 'revoked', nextAt: null };
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { state: 'expired', nextAt: null };
  const warningAt = expiresAt - expiringWindow;
  if (warningAt <= now) return { state: 'expiring', nextAt: expiresAt };
  return { state: 'active', nextAt: warningAt };
}
