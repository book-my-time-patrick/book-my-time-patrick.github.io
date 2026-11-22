import { DAY, MAX_BOOKING_DAYS, MAX_BUFFER, clockOf, minuteOf, ruleClock, ruleDate } from '../../shared/booking-rules';
import type { BookingRules } from '../../shared/booking-rules';
import type { PanelActions } from './admin-m2';
import { escapeHtml as e } from './ui';

type Field = {
  key: keyof BookingRules;
  label: string;
  html: (rules: BookingRules) => string;
  read: (group: HTMLElement) => unknown;
};
type NumericKey = 'leadMinutes' | 'horizonDays' | 'bufferBefore' | 'bufferAfter' | 'dailyLimit' | 'weeklyLimit';
const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const text = (group: HTMLElement) => group.querySelector<HTMLInputElement | HTMLTextAreaElement>('fieldset input, textarea')!.value.trim();

function numberField(key: NumericKey, label: string, min: number, max: number): Field {
  return { key, label,
    html: rules => `<label class="admin-field">${label}<input type="number" value="${rules[key]}" min="${min}" max="${max}" required></label>`,
    read: group => Number(text(group)),
  };
}
function readHours(group: HTMLElement) {
  return dayNames.map((_, day) => {
    const value = group.querySelector<HTMLInputElement>(`[data-weekday="${day}"]`)!.value.trim();
    if (!value) return [];
    return value.split(/[,，]/).map(range => {
      const match = /^([01]\d:[0-5]\d|2[0-3]:[0-5]\d)\s*[-–]\s*([01]\d:[0-5]\d|2[0-3]:[0-5]\d|24:00)$/.exec(range.trim());
      return match ? [minuteOf(match[1]), minuteOf(match[2])] : [NaN, NaN];
    }).sort((a, b) => a[0] - b[0]);
  });
}
const fields: Field[] = [
  { key: 'weeklyHours', label: '每周可约时段', read: readHours, html: rules =>
    `<legend>每周可约时段</legend><div class="admin-rule-fields">${[1, 2, 3, 4, 5, 6, 0].map(day =>
      `<label class="admin-field">${dayNames[day]}<input data-weekday="${day}" maxlength="128" placeholder="休息" value="${e(rules.weeklyHours[day].map(([from, through]) => clockOf(from) + '–' + clockOf(through)).join(', '))}"></label>`).join('')}</div>
      <p class="admin-help">用 09:00–12:00, 14:00–18:00 的格式填写。每段须在同一天，留空表示休息。</p>` },
  { key: 'blockedDates', label: '屏蔽日期', read: group => text(group).split(/[\s,，]+/).filter(Boolean),
    html: rules => `<label class="admin-field">屏蔽日期<textarea rows="2" maxlength="4400" placeholder="例如 2026-12-25">${e(rules.blockedDates.join('\n'))}</textarea><span class="admin-help">日期间用换行或逗号分隔。</span></label>` },
  { key: 'timeZone', label: '基准时区', read: text,
    html: rules => `<label class="admin-field">基准时区<input list="booking-timezones" maxlength="80" value="${e(rules.timeZone)}" required><span class="admin-help">使用 IANA 时区名称，例如 Asia/Shanghai。</span></label>` },
  numberField('leadMinutes', '最短提前量（分钟）', 0, MAX_BOOKING_DAYS * 1440),
  numberField('horizonDays', '最远可约天数', 1, MAX_BOOKING_DAYS),
  { key: 'stepMinutes', label: '起点间隔', read: group => Number(group.querySelector('select')!.value),
    html: rules => `<label class="admin-field">起点间隔<select>${[15, 30].map(step => `<option value="${step}"${rules.stepMinutes === step ? ' selected' : ''}>${step} 分钟</option>`).join('')}</select></label>` },
  { key: 'durations', label: '可选时长',
    read: group => [...group.querySelectorAll<HTMLInputElement>('fieldset input:checked')].map(item => Number(item.value)),
    html: rules => `<legend>可选时长</legend><div class="admin-rule-durations">${Array.from({ length: 8 }, (_, i) => (i + 1) * 15)
      .map(n => `<label class="admin-checkbox"><input type="checkbox" value="${n}"${rules.durations.includes(n) ? ' checked' : ''}>${n} 分钟</label>`).join('')}</div>` },
  numberField('bufferBefore', '预约前缓冲（分钟）', 0, MAX_BUFFER),
  numberField('bufferAfter', '预约后缓冲（分钟）', 0, MAX_BUFFER),
  numberField('dailyLimit', '每日确认上限', 0, 100),
  numberField('weeklyLimit', '每周确认上限', 0, 100),
];

function ruleFields(global: BookingRules, overrides?: Partial<BookingRules>) {
  const values = { ...global, ...overrides };
  return `<datalist id="booking-timezones">${['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo',
    'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC'].map(zone => `<option value="${zone}"></option>`).join('')}</datalist>
    <div class="admin-rule-fields">${fields.map(field => {
      const active = overrides && Object.hasOwn(overrides, field.key);
      const wide = ['weeklyHours', 'blockedDates', 'durations'].includes(field.key);
      return `<div class="${wide ? 'admin-rule-wide' : ''}" data-rule="${field.key}">
        ${overrides ? `<label class="admin-checkbox"><input type="checkbox" data-override${active ? ' checked' : ''}>覆盖「${field.label}」</label>` : ''}
        <fieldset class="admin-rule-controls"${overrides && !active ? ' disabled' : ''}>${field.html(values)}</fieldset>
      </div>`;
    }).join('')}</div>`;
}
export function inviteRuleFields(global: BookingRules, overrides?: Partial<BookingRules> | null) {
  return `<details class="admin-setup-manual admin-invite-rules"${overrides && Object.keys(overrides).length ? ' open' : ''}>
    <summary>为此邀请覆盖预约规则</summary>
    <p class="admin-help">仅覆盖勾选的项目。时段、屏蔽日期和时长按整项替换。上限填 0 表示不限。</p>
    ${ruleFields(global, overrides ?? {})}</details>`;
}
export function bindInviteRuleFields(form: HTMLFormElement) {
  for (const toggle of form.querySelectorAll<HTMLInputElement>('[data-override]')) {
    toggle.addEventListener('change', () => { toggle.closest('[data-rule]')!.querySelector('fieldset')!.disabled = !toggle.checked; });
  }
}
export function readRuleFields(form: HTMLFormElement): Partial<BookingRules> {
  return Object.fromEntries(fields.flatMap(field => {
    const group = form.querySelector<HTMLElement>(`[data-rule="${field.key}"]`)!;
    return group.querySelector('fieldset')!.disabled ? [] : [[field.key, field.read(group)]];
  }));
}
export function renderBookingRules(content: HTMLElement, rules: BookingRules, actions: PanelActions) {
  content.innerHTML = `<section class="admin-card"><h2>普通预约规则</h2>
    <p class="admin-copy">提前量填 0 可当天预约，上限填 0 表示不限。上限统计站内已确认的普通预约，每周从周一开始。开放局的名额在发布场次时设置。</p>
    <form>${ruleFields(rules)}<div class="admin-actions"><button type="submit" class="primary">保存预约规则</button></div></form>
  </section>`;
  const form = content.querySelector('form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void actions.run(async () => {
      const { rules: saved } = await actions.request<{ rules: BookingRules }>('/admin/booking-rules', readRuleFields(form), 'PATCH');
      if (!actions.isCurrent()) return;
      renderBookingRules(content, saved, actions);
      actions.banner('预约规则已保存，新请求将使用最新设置。');
    }, form.querySelector<HTMLButtonElement>('button[type=submit]')!);
  });
}

export function ruleTimeFields(rules: Pick<BookingRules, 'timeZone' | 'stepMinutes' | 'durations' | 'horizonDays'>, startAt?: number, minutes?: number) {
  const now = Date.now();
  const zone = rules.timeZone;
  return `<p class="admin-help">基准时区 · ${e(zone)}</p><div class="admin-form-row">
    <label class="admin-field">日期<input type="date" name="date" min="${ruleDate(now, zone)}" max="${ruleDate(now + DAY * rules.horizonDays, zone)}" value="${startAt ? ruleDate(startAt, zone) : ''}" required></label>
    <label class="admin-field">开始时间<input type="time" name="time" min="00:00" step="${rules.stepMinutes * 60}" value="${startAt ? ruleClock(startAt, zone) : ''}" required></label></div>
    <label class="admin-field">时长<select name="duration">${rules.durations.map(n => `<option value="${n}"${n === minutes ? ' selected' : ''}>${n} 分钟</option>`).join('')}</select></label>`;
}
