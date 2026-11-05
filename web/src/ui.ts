export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '尚无记录';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return '尚无记录';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export const moduleNames: Record<string, string> = {
  profile: '个人介绍', calendar: '预约日历', travel: '城市行程', tracks: '关注方向', investments: '投资经历', contact: '联系方式',
};
export const modeNames: Record<string, string> = { request: '申请时间', direct: '直接预约', open: '开放局' };

export async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; }
  catch { return false; }
}
