import { BOOKING_DAY, BOOKING_TIMEZONE, REQUEST_DURATIONS, REQUEST_HORIZON, bookingDate } from '../../shared/booking';
import { escapeHtml as e } from './ui';
import type { PanelActions, RequestFilter } from './admin-m2';

const MAX_DATES = 12;
const HALF_HOUR = 30 * 60_000;
const colors = { blue: '蓝色', plum: '梅紫色', green: '绿色', amber: '琥珀色' };
type Color = keyof typeof colors;
interface ActivityType {
  id: string;
  name: string;
  emoji: string;
  color: Color;
  duration: number;
  location: string;
  capacity: number | null;
}
interface OpenSession {
  id: string;
  title: string;
  emoji: string;
  color: Color;
  startAt: number;
  endAt: number;
  location: string;
  description: string;
  mapUrl: string;
  capacity: number | null;
  remaining: number | null;
  approvalRequired: boolean;
  emailRequired: boolean;
  inviteIds: string[];
  confirmed: number;
  pending: number;
  archived: boolean;
  conflict: boolean;
  typeId: string;
}
export interface OpenSettings {
  now: number;
  types: ActivityType[];
  sessions: OpenSession[];
  invites: { id: string; label: string }[];
}

const dateAndTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BOOKING_TIMEZONE, month: 'numeric', day: 'numeric', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const timeOnly = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BOOKING_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const clockTimes = Array.from({ length: 24 }, (_, index) =>
  `${String(9 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);
const at = (date: string, clock: string) => Date.parse(`${date}T${clock}:00+08:00`);
const textValue = (data: FormData, name: string) => String(data.get(name) ?? '').trim();

function durationOptions(selected: number) {
  return REQUEST_DURATIONS.map(minutes => `<option value="${minutes}"${minutes === selected ? ' selected' : ''}>${minutes} 分钟</option>`).join('');
}
function capacityFields(capacity: number | null) {
  return `<label class="admin-field">名额<input name="capacity" type="number" min="1" max="100" value="${e(capacity ?? 1)}" required></label>
    <label class="admin-checkbox"><input type="checkbox" name="unlimited"${capacity === null ? ' checked' : ''}>不限人数</label>`;
}
function connectCapacity(form: HTMLFormElement) {
  const capacity = form.querySelector<HTMLInputElement>('[name="capacity"]')!;
  const unlimited = form.querySelector<HTMLInputElement>('[name="unlimited"]')!;
  const update = () => { capacity.disabled = unlimited.checked; };
  unlimited.addEventListener('change', update);
  update();
  return (value: number | null) => {
    capacity.value = String(value ?? 1);
    unlimited.checked = value === null;
    update();
  };
}
function readCapacity(data: FormData) {
  return data.has('unlimited') ? null : Number(data.get('capacity'));
}
function onSubmit(form: HTMLFormElement, actions: PanelActions, submit: (data: FormData) => Promise<void>) {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  form.addEventListener('invalid', event => {
    const details = (event.target as HTMLElement).closest<HTMLDetailsElement>('details');
    if (details) details.open = true;
  }, true);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!actions.isCurrent()) return;
    const data = new FormData(form);
    void actions.run(() => submit(data), button);
  });
}

function renderTypeEditor(target: HTMLElement, actions: PanelActions, type?: ActivityType) {
  target.innerHTML = `<form class="admin-m2-editor" method="post" aria-label="${type ? '编辑活动类型' : '新增活动类型'}">
    <h4>${type ? '编辑活动类型' : '新增活动类型'}</h4>
    <div class="admin-form-row">
      <label class="admin-field">名称<input name="name" maxlength="36" value="${e(type?.name)}" required></label>
      <label class="admin-field">Emoji<input name="emoji" maxlength="32" value="${e(type?.emoji ?? '☕')}" required></label>
    </div>
    <div class="admin-form-row">
      <label class="admin-field">颜色<select name="color">${Object.entries(colors).map(([value, label]) => `<option value="${value}"${(type?.color ?? 'blue') === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="admin-field">默认时长<select name="duration">${durationOptions(type?.duration ?? 60)}</select></label>
    </div>
    <label class="admin-field">默认地点<input name="location" maxlength="100" value="${e(type?.location)}"></label>
    ${capacityFields(type ? type.capacity : 1)}
    <div class="admin-actions"><button class="primary" type="submit">保存活动类型</button><button class="text-button" type="button" data-close-type>返回</button></div>
  </form>`;
  const form = target.querySelector<HTMLFormElement>('form')!;
  connectCapacity(form);
  form.querySelector('[data-close-type]')!.addEventListener('click', () => target.replaceChildren());
  onSubmit(form, actions, async data => {
    const name = textValue(data, 'name');
    const emoji = textValue(data, 'emoji');
    if (!name || !emoji) { actions.banner('请填写活动类型名称和 Emoji。', true); return; }
    const input = {
      name, emoji, color: textValue(data, 'color'), duration: Number(data.get('duration')),
      location: textValue(data, 'location'), capacity: readCapacity(data),
    };
    await actions.request(type ? `/admin/open-types/${encodeURIComponent(type.id)}` : '/admin/open-types', input, type ? 'PATCH' : 'POST');
    if (actions.isCurrent()) await actions.reload(type ? '活动类型已更新。' : '活动类型已添加。');
  });
  form.querySelector<HTMLInputElement>('[name="name"]')!.focus();
}

function renderPublishForm(target: HTMLElement, settings: OpenSettings, actions: PanelActions, now: () => number) {
  const first = settings.types[0];
  if (!first) {
    target.innerHTML = '<p class="admin-empty">请先添加一个活动类型，再发布开放局。</p>';
    return (_session: OpenSession) => {};
  }
  const today = bookingDate(now());
  const lastDate = bookingDate(now() + REQUEST_HORIZON);
  const nextHalfHour = (Math.floor(now() / HALF_HOUR) + 1) * HALF_HOUR;
  const todayHasTime = Math.max(nextHalfHour, at(today, '09:00')) + first.duration * 60_000 <= at(today, '21:00');
  const firstDate = todayHasTime ? today : bookingDate(now() + BOOKING_DAY);
  target.innerHTML = `<form method="post" aria-label="发布开放局">
    <label class="admin-field">活动类型<select name="typeId" required>${settings.types.map(type => `<option value="${e(type.id)}">${e(type.emoji)} ${e(type.name)}</option>`).join('')}</select></label>
    <p class="admin-help">北京时间（UTC+8） · 每日 09:00–21:00</p>
    <div class="admin-form-row">
      <label class="admin-field">日期<input name="date" type="date" min="${today}" max="${lastDate}" value="${firstDate}" required></label>
      <label class="admin-field">开始时间<select name="time" required></select></label>
    </div>
    <div class="admin-form-row">
      <label class="admin-field">时长<select name="duration">${durationOptions(first.duration)}</select></label>
      <label class="admin-field">地点<input name="location" maxlength="100" value="${e(first.location)}"></label>
    </div>
    <details data-schedule-options>
      <summary class="text-button">批量发布</summary>
      <label class="admin-field">日期安排<select name="repeat"><option value="once">只发布这一天</option><option value="weekly">每周同一天</option><option value="workdays">日期区间内的工作日</option><option value="selected">手动指定其他日期</option></select></label>
      <div data-repeat-weekly hidden><label class="admin-field">总场次（含所选日期）<input name="weeks" type="number" min="2" max="5" value="4"></label></div>
      <div data-repeat-workdays hidden><label class="admin-field">区间结束日期<input name="through" type="date" min="${firstDate}" max="${lastDate}" value="${firstDate}"></label></div>
      <div data-repeat-selected hidden>
        <div class="admin-form-row"><label class="admin-field">其他日期<input name="extraDate" type="date" min="${today}" max="${lastDate}"></label><div class="admin-actions"><button class="secondary" type="button" data-add-date>添加日期</button></div></div>
        <div class="admin-actions" data-extra-dates aria-label="其他日期"></div>
      </div>
    </details>
    <details data-open-options>
      <summary class="text-button">名额、确认与可见范围</summary>
      <div class="admin-m2-editor">
        ${capacityFields(first.capacity)}
        <label class="admin-field">预约方式<select name="confirmation"><option value="direct">提交后直接确认</option><option value="approval">需要我确认</option></select></label>
        <label class="admin-checkbox"><input type="checkbox" name="emailRequired">要求填写邮箱</label>
        <label class="admin-field">可见范围<select name="scope"><option value="all">所有启用开放局的邀请</option><option value="selected">仅指定邀请</option></select></label>
        <div data-open-invite-options hidden>${settings.invites.length ? `<div class="admin-check-grid">${settings.invites.map(invite => `<label class="admin-checkbox"><input type="checkbox" name="inviteIds" value="${e(invite.id)}">${e(invite.label)}</label>`).join('')}</div>` : '<p class="admin-help">暂无启用开放局的有效邀请。</p>'}</div>
        <label class="admin-field">简介（可选）<textarea name="description" rows="3" maxlength="500"></textarea></label>
        <label class="admin-field">地图链接（可选）<input name="mapUrl" type="url" maxlength="512" placeholder="https://" autocomplete="off"></label>
      </div>
    </details>
    <p class="admin-inline-note" data-publish-summary role="status"></p>
    <div class="admin-actions"><button class="primary" type="submit">发布开放局</button></div>
  </form>`;
  const form = target.querySelector<HTMLFormElement>('form')!;
  const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string) => form.querySelector<T>(`[name="${name}"]`)!;
  const typeSelect = field<HTMLSelectElement>('typeId');
  const date = field<HTMLInputElement>('date');
  const time = field<HTMLSelectElement>('time');
  const duration = field<HTMLSelectElement>('duration');
  const repeat = field<HTMLSelectElement>('repeat');
  const through = field<HTMLInputElement>('through');
  const weeks = field<HTMLInputElement>('weeks');
  const extraDate = field<HTMLInputElement>('extraDate');
  const scope = field<HTMLSelectElement>('scope');
  const summary = form.querySelector<HTMLElement>('[data-publish-summary]')!;
  const extraDates = new Set<string>();
  const setCapacity = connectCapacity(form);
  let preferredTime = '';

  function selectedDates(): string[] {
    if (!date.value) return [];
    const start = Date.parse(`${date.value}T12:00:00Z`);
    if (!Number.isFinite(start)) return [];
    if (repeat.value === 'weekly') {
      if (!weeks.checkValidity() || !weeks.value) return [];
      return Array.from({ length: Number(weeks.value) }, (_, index) => bookingDate(start + index * 7 * BOOKING_DAY));
    }
    if (repeat.value === 'workdays') {
      const end = Date.parse(`${through.value}T12:00:00Z`);
      if (!Number.isFinite(end) || end < start || end - start > REQUEST_HORIZON) return [];
      const dates: string[] = [];
      for (let day = start; day <= end; day += BOOKING_DAY) {
        const weekday = new Date(day).getUTCDay();
        if (weekday >= 1 && weekday <= 5) dates.push(bookingDate(day));
      }
      return dates;
    }
    return repeat.value === 'selected' ? [...new Set([date.value, ...extraDates])].sort() : [date.value];
  }
  function updateTimes(preferred = preferredTime || time.value) {
    const dates = selectedDates();
    const current = now();
    const minutes = Number(duration.value);
    const valid = clockTimes.filter(clock => dates.length > 0 && dates.every(day => {
      const start = at(day, clock);
      return start > current && start <= current + REQUEST_HORIZON && start + minutes * 60_000 <= at(day, '21:00');
    }));
    time.innerHTML = valid.length ? valid.map(clock => `<option value="${clock}">${clock}</option>`).join('') : '<option value="">无共同可用时间</option>';
    if (valid.includes(preferred)) time.value = preferred;
    summary.textContent = dates.length > MAX_DATES ? `所选日期有 ${dates.length} 天。每次最多发布 ${MAX_DATES} 场。`
      : valid.length ? `将在 ${dates.length} 个日期发布开放局。` : '请选择未来 30 天内的日期和完整时段。';
  }
  function renderExtraDates() {
    const list = form.querySelector<HTMLElement>('[data-extra-dates]')!;
    list.replaceChildren();
    for (const value of [...extraDates].sort()) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = `${value} ×`;
      remove.setAttribute('aria-label', `移除 ${value}`);
      remove.addEventListener('click', () => { extraDates.delete(value); renderExtraDates(); updateTimes(); });
      list.append(remove);
    }
  }
  function updateRepeat() {
    for (const [mode, input] of [['weekly', weeks], ['workdays', through], ['selected', extraDate]] as const) {
      form.querySelector<HTMLElement>(`[data-repeat-${mode}]`)!.hidden = repeat.value !== mode;
      input.disabled = repeat.value !== mode;
    }
    updateTimes();
  }
  function updateScope() { form.querySelector<HTMLElement>('[data-open-invite-options]')!.hidden = scope.value !== 'selected'; }

  typeSelect.addEventListener('change', () => {
    const type = settings.types.find(item => item.id === typeSelect.value);
    if (!type) return;
    duration.value = String(type.duration);
    field<HTMLInputElement>('location').value = type.location;
    setCapacity(type.capacity);
    updateTimes();
  });
  date.addEventListener('change', () => {
    through.min = date.value || today;
    if (through.value < through.min) through.value = through.min;
    extraDates.delete(date.value);
    renderExtraDates();
    updateTimes();
  });
  form.querySelector('[data-add-date]')!.addEventListener('click', () => {
    if (!extraDate.value || !extraDate.reportValidity()) return;
    if (extraDate.value === date.value || extraDates.has(extraDate.value)) {
      actions.banner('这一天已经在日期安排中。', true);
      return;
    }
    if (extraDates.size >= MAX_DATES - 1) { actions.banner(`每次最多发布 ${MAX_DATES} 场。`, true); return; }
    extraDates.add(extraDate.value);
    extraDate.value = '';
    renderExtraDates();
    updateTimes();
  });
  for (const input of [duration, weeks, through]) input.addEventListener('change', () => updateTimes());
  time.addEventListener('change', () => { preferredTime = time.value; });
  repeat.addEventListener('change', updateRepeat);
  scope.addEventListener('change', updateScope);
  updateRepeat();
  updateScope();

  onSubmit(form, actions, async data => {
    const minutes = Number(data.get('duration'));
    const dates = selectedDates();
    const clock = textValue(data, 'time');
    const current = now();
    const startAts = dates.map(day => at(day, clock));
    if (repeat.value === 'selected' && extraDate.value) { actions.banner('请点击「添加日期」保存额外的日期。', true); return; }
    if (!dates.length || dates.length > MAX_DATES) { actions.banner(`每次请选择 1–${MAX_DATES} 个日期。`, true); return; }
    if (startAts.some((start, index) => !Number.isFinite(start) || start <= current || start > current + REQUEST_HORIZON || start + minutes * 60_000 > at(dates[index], '21:00'))) {
      actions.banner('请选择未来 30 天内的时间，整段时长需在北京时间 09:00–21:00 内。', true);
      updateTimes();
      return;
    }
    const inviteIds = scope.value === 'selected' ? data.getAll('inviteIds').map(String) : [];
    if (scope.value === 'selected' && !inviteIds.length) {
      actions.banner('请选择至少一个邀请链接。', true);
      return;
    }
    const mapUrl = textValue(data, 'mapUrl');
    if (mapUrl) {
      try {
        const url = new URL(mapUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
      } catch { actions.banner('请使用不含账号信息的 HTTPS 地图链接。', true); return; }
    }
    await actions.request('/admin/open-sessions', {
      typeId: textValue(data, 'typeId'), startAts, duration: minutes, location: textValue(data, 'location'),
      description: textValue(data, 'description'), mapUrl, capacity: readCapacity(data),
      approvalRequired: textValue(data, 'confirmation') === 'approval', emailRequired: data.has('emailRequired'), inviteIds,
    });
    if (actions.isCurrent()) await actions.reload(`已发布 ${dates.length} 场开放局。`);
  });

  return (session: OpenSession) => {
    typeSelect.value = session.typeId;
    duration.value = String((session.endAt - session.startAt) / 60_000);
    field<HTMLInputElement>('location').value = session.location;
    field<HTMLTextAreaElement>('description').value = session.description;
    field<HTMLInputElement>('mapUrl').value = session.mapUrl ?? '';
    field<HTMLSelectElement>('confirmation').value = session.approvalRequired ? 'approval' : 'direct';
    field<HTMLInputElement>('emailRequired').checked = session.emailRequired;
    setCapacity(session.capacity);
    scope.value = session.inviteIds.length ? 'selected' : 'all';
    form.querySelectorAll<HTMLInputElement>('[name="inviteIds"]').forEach(input => { input.checked = session.inviteIds.includes(input.value); });
    form.querySelector<HTMLDetailsElement>('[data-open-options]')!.open = true;
    repeat.value = 'once';
    date.value = '';
    through.value = '';
    preferredTime = timeOnly.format(session.startAt);
    extraDates.clear();
    renderExtraDates();
    updateRepeat();
    updateScope();
    date.focus();
    const missingInvite = session.inviteIds.some(id => !settings.invites.some(invite => invite.id === id));
    actions.banner(missingInvite ? '已带入开放局。部分原邀请已不可用，请核对可见范围并选择新日期。' : '已带入开放局，请选择新日期后发布。');
  };
}

export function renderOpenSessions(content: HTMLElement, settings: OpenSettings, actions: PanelActions, showBookings: (filter: RequestFilter) => void) {
  const observedAt = performance.now();
  const serverNow = Number.isFinite(settings.now) ? settings.now : Date.now();
  const now = () => serverNow + performance.now() - observedAt;
  const active = settings.sessions.filter(session => !session.archived && session.endAt > now());
  const history = settings.sessions.filter(session => session.archived || session.endAt <= now());
  content.innerHTML = `<div class="admin-grid">
    <div><section class="admin-card admin-m2-settings"><h2>发布开放局</h2><div data-open-publish></div></section></div>
    <div><section class="admin-card">
      <div class="admin-section-head"><h2>已发布</h2><button class="text-button" type="button" data-open-refresh>刷新</button></div>
      <div class="admin-list" data-open-active></div>
      ${history.length ? `<details><summary class="text-button">历史记录（${history.length}）</summary><div class="admin-list" data-open-history></div></details>` : ''}
    </section>
    <section class="admin-card">
      <div class="admin-section-head"><h2>活动类型</h2><button class="secondary" type="button" data-add-type>新增类型</button></div>
      <div data-type-editor></div>
      <div class="admin-list" data-open-types></div>
    </section></div>
  </div>`;
  const copySession = renderPublishForm(content.querySelector('[data-open-publish]')!, settings, actions, now);
  const refresh = content.querySelector<HTMLButtonElement>('[data-open-refresh]')!;
  refresh.addEventListener('click', () => void actions.run(() => actions.reload(), refresh));
  const editor = content.querySelector<HTMLElement>('[data-type-editor]')!;
  content.querySelector('[data-add-type]')!.addEventListener('click', () => renderTypeEditor(editor, actions));
  const types = content.querySelector<HTMLElement>('[data-open-types]')!;
  if (!settings.types.length) types.innerHTML = '<p class="admin-empty">暂无活动类型。</p>';
  for (const type of settings.types) {
    const item = document.createElement('article');
    item.className = 'admin-item';
    const location = type.location ? ` · ${type.location}` : '';
    item.innerHTML = `<div class="admin-item-head"><h3>${e(type.emoji)} ${e(type.name)}</h3><span class="admin-pill muted">${e(colors[type.color])}</span></div>
      <p class="admin-item-description">${e(type.duration)} 分钟 · ${type.capacity === null ? '不限人数' : `${e(type.capacity)} 人`}${e(location)}</p>
      <div class="admin-actions"><button class="secondary" type="button" data-edit-type>编辑</button><button class="text-button admin-danger" type="button" data-remove-type>移除</button></div>`;
    item.querySelector('[data-edit-type]')!.addEventListener('click', () => renderTypeEditor(editor, actions, type));
    const remove = item.querySelector<HTMLButtonElement>('[data-remove-type]')!;
    remove.addEventListener('click', () => {
      if (!confirm(`确定移除「${type.name}」？已发布的开放局会保留。`)) return;
      void actions.run(async () => {
        await actions.request(`/admin/open-types/${encodeURIComponent(type.id)}`, undefined, 'DELETE');
        if (actions.isCurrent()) await actions.reload('活动类型已移除。');
      }, remove);
    });
    types.append(item);
  }

  function addSessions(sessions: OpenSession[], list: HTMLElement) {
    for (const session of sessions) {
      const item = document.createElement('article');
      item.className = 'admin-item';
      const ended = session.endAt <= now();
      const stopped = ended || session.archived;
      const state = ended ? '已结束' : session.archived ? '已停止' : session.conflict ? '日历冲突 · 已隐藏'
        : session.startAt <= now() ? '进行中' : session.remaining === 0 ? '已约满' : '可预约';
      const visible = session.inviteIds.length ? `指定 ${session.inviteIds.length} 个邀请` : '所有启用开放局的邀请';
      item.innerHTML = `<div class="admin-item-head"><h3>${e(session.emoji)} ${e(session.title)}</h3><span class="admin-pill${stopped ? ' muted' : session.conflict ? ' invite-expiring' : ''}">${state}</span></div>
        <p class="admin-m2-time">${e(dateAndTime.format(session.startAt))}–${e(timeOnly.format(session.endAt))}</p>
        ${session.location ? `<p class="admin-item-description">${e(session.location)}</p>` : ''}
        <div class="admin-item-meta"><span>已确认 ${e(session.confirmed)}${session.capacity === null ? ' · 不限人数' : ` / ${e(session.capacity)} 人`}</span><span>待确认 ${e(session.pending)} 人</span><span>${e(visible)}</span></div>
        <div class="admin-actions">
          ${settings.types.some(type => type.id === session.typeId) ? '<button class="secondary" type="button" data-open-copy>复制到其他日期</button>' : ''}
          ${session.confirmed || session.pending ? '<button class="text-button" type="button" data-open-bookings>查看预约</button>' : ''}
          ${stopped ? '' : '<button class="text-button admin-danger" type="button" data-open-stop>停止接受预约</button>'}
        </div>`;
      item.querySelector('[data-open-copy]')?.addEventListener('click', () => copySession(session));
      item.querySelector('[data-open-bookings]')?.addEventListener('click', () => showBookings(session.pending ? 'pending' : 'confirmed'));
      const stop = item.querySelector<HTMLButtonElement>('[data-open-stop]');
      stop?.addEventListener('click', () => {
        if (!confirm(`停止接受「${session.title}」的新预约？已确认的预约会保留。`)) return;
        void actions.run(async () => {
          await actions.request(`/admin/open-sessions/${encodeURIComponent(session.id)}`, undefined, 'DELETE');
          if (actions.isCurrent()) await actions.reload('已停止接受新预约。');
        }, stop);
      });
      list.append(item);
    }
  }
  const currentList = content.querySelector<HTMLElement>('[data-open-active]')!;
  if (!active.length) currentList.innerHTML = '<p class="admin-empty">暂无已发布的开放局。</p>';
  addSessions(active, currentList);
  const historyList = content.querySelector<HTMLElement>('[data-open-history]');
  if (historyList) addSessions(history, historyList);
}
