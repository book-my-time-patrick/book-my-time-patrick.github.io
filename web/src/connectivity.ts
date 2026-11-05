export type ProbeResult = { ok: boolean; milliseconds: number; message: string; unconfigured?: true };
export type CheckRecord = {
  checkedAt: string;
  carrier: string;
  connection: string;
  frontend: ProbeResult;
  api: ProbeResult;
};

export const carriers = ['电信', '联通', '移动', '其他'] as const;
export const connections = ['4G / 5G', 'Wi-Fi'] as const;
const storageKey = 'invited-booking-connectivity-v1';

export function probeLabel(result: ProbeResult): string {
  return result.unconfigured ? '待配置' : result.ok ? '通过' : '失败';
}

export async function probe(url: string | null, service: string): Promise<ProbeResult> {
  if (url === null) return { ok: false, milliseconds: 0, message: '服务尚未配置', unconfigured: true };
  const started = performance.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json() as { ok?: boolean; service?: string };
    if (!response.ok || result.ok !== true || result.service !== service) {
      throw new Error('INVALID_RESPONSE');
    }
    return { ok: true, milliseconds: Math.round(performance.now() - started), message: '连接正常' };
  } catch {
    return { ok: false, milliseconds: Math.round(performance.now() - started), message: '连接失败，请检查网络或部署配置' };
  }
}

function isProbe(value: unknown): value is ProbeResult {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as ProbeResult;
  return typeof item.ok === 'boolean' && Number.isFinite(item.milliseconds) && item.milliseconds >= 0 && typeof item.message === 'string' && item.message.length < 100 && (item.unconfigured === undefined || (item.unconfigured === true && !item.ok && item.milliseconds === 0));
}

export function loadRecords(): CheckRecord[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(data)) return [];
    return data.filter((item: CheckRecord) => item && Number.isFinite(Date.parse(item.checkedAt)) && carriers.includes(item.carrier as typeof carriers[number]) && connections.includes(item.connection as typeof connections[number]) && isProbe(item.frontend) && isProbe(item.api)).slice(-40);
  } catch {
    return [];
  }
}

export function saveRecords(records: CheckRecord[]): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(records.slice(-40)));
    return true;
  } catch {
    return false;
  }
}

export function exportRecords(records: CheckRecord[]) {
  const headings = ['测试时间（北京时间）', '运营商', '网络', '前端', '前端耗时ms', 'API', 'API耗时ms'];
  const rows = records.map((record) => [
    new Date(record.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    record.carrier, record.connection,
    probeLabel(record.frontend), record.frontend.milliseconds,
    probeLabel(record.api), record.api.milliseconds,
  ]);
  const csv = [headings, ...rows].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '可达性测试记录.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
