import './invitation-booking.css';
import { bookingDate, isRequestSlot, parseEmailAddress, requestWeek, REQUEST_DURATIONS } from '../../shared/booking';
import type { SlotState } from '../../shared/booking';
import { copyText, escapeHtml as e } from './ui';

interface Slot { startAt: number; state: SlotState }
interface Day { date: string; slots: Slot[]; city?: string }
interface Week {
  now: number; week: number; maxWeek: number; weekStart: string; canSubmit: boolean;
  days: Day[]; durations: readonly number[];
}
interface Options {
  showCalendar: boolean; showCity: boolean; allowRequest: boolean; preview: boolean;
  send: (path: string, body?: object, signal?: AbortSignal) => Promise<unknown>;
  unavailable: () => void;
}

export class InvitationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const minute = 60_000;
const step = 30 * minute;
const chinaOffset = 8 * 60 * minute;
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const stateNames: Record<SlotState, string> = { expired: '已过期', request: '可申请', unavailable: '未开放' };
const time = (instant: number) => new Date(instant + chinaOffset).toISOString().slice(11, 16);
const shortDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const dateNumber = (date: string) => Number(date.slice(8, 10));
const dayStart = (date: string) => Date.parse(`${date}T09:00:00+08:00`);
const pin = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.5 8c0 4-5.5 8.4-5.5 8.4S4.5 12 4.5 8a5.5 5.5 0 1 1 11 0Z"/><circle cx="10" cy="8" r="1.7"/></svg>';

function readWeek(value: unknown): Week {
  const data = value as Week | undefined;
  if (!data || !Number.isSafeInteger(data.now) || !Number.isInteger(data.week) || !Number.isInteger(data.maxWeek)
    || data.week < 0 || data.week > data.maxWeek || data.maxWeek > 6 || typeof data.canSubmit !== 'boolean'
    || !Array.isArray(data.days) || data.days.length !== 7 || !Array.isArray(data.durations)
    || !data.durations.length || data.durations.some(duration => !REQUEST_DURATIONS.some(length => length === duration))) {
    throw new Error('Invalid calendar');
  }
  for (const day of data.days) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(dayStart(day.date))
      || !Array.isArray(day.slots) || day.slots.length > 24
      || day.slots.some(slot => !slot || !Number.isSafeInteger(slot.startAt) || !Object.hasOwn(stateNames, slot.state)
        || slot.startAt < dayStart(day.date) || slot.startAt >= dayStart(day.date) + 24 * step
        || slot.startAt % step !== 0)) throw new Error('Invalid calendar day');
  }
  if (data.weekStart !== data.days[0].date) throw new Error('Invalid week start');
  return data;
}

export function renderInvitationBooking(root: HTMLElement, options: Options): () => void {
  const { showCalendar, showCity, allowRequest, preview, send, unavailable } = options;
  const navigation = `<div class="booking-period-nav" aria-label="切换日期范围" role="group">
    <button class="secondary booking-nav-arrow" type="button" data-calendar-step="-1" aria-label="上一周" disabled><span aria-hidden="true">‹</span></button>
    <div class="booking-period" aria-live="polite">
      <span data-period-note class="booking-period-note">中国标准时间</span>
      <p class="booking-week-range" data-week-range>本周</p>
    </div>
    <button class="secondary booking-nav-arrow" type="button" data-calendar-step="1" aria-label="下一周" disabled><span aria-hidden="true">›</span></button>
  </div>`;
  const weekFeedback = '<p class="booking-feedback" data-calendar-message role="status" aria-live="polite"></p>';
  root.innerHTML = `
    ${showCalendar ? `<section class="invitation-card booking-card booking-calendar-card" aria-labelledby="booking-calendar-title">
      <div class="booking-section-head booking-calendar-head">
        <div><p class="eyebrow">AVAILABILITY</p><h2 id="booking-calendar-title">预约日历</h2></div>
        <div class="booking-view-toggle" role="group" aria-label="日历视图">
          <button type="button" data-calendar-view="week" aria-pressed="false">周视图</button>
          <button type="button" data-calendar-view="day" aria-pressed="false">日视图</button>
        </div>
      </div>
      ${navigation}
      ${weekFeedback}
      <div class="booking-legend" aria-label="周历图例">
        <span><i class="booking-key request" aria-hidden="true"></i>可申请</span>
        ${allowRequest ? '<span><i class="booking-key selected" aria-hidden="true">✓</i>已选择</span>' : ''}
        <span><i class="booking-key expired" aria-hidden="true"></i>已过期</span>
        <span><i class="booking-key unavailable" aria-hidden="true">–</i>未开放</span>
        <span class="booking-legend-zone">UTC+8</span>
      </div>
      <div data-calendar class="booking-calendar" aria-busy="true"></div>
      <p class="booking-caption">「可申请」表示可提出的时间。实际能否见面由邀请人确认。</p>
    </section>` : ''}
    ${allowRequest ? `<section class="invitation-card booking-card" aria-labelledby="booking-request-title">
      <div class="booking-section-head"><div><p class="eyebrow">PROPOSE A TIME</p><h2 id="booking-request-title" tabindex="-1">预约其他时间</h2></div><span class="booking-zone">待邀请人确认</span></div>
      ${showCalendar ? '' : navigation + weekFeedback}
      <p class="booking-caption">请选择工作日的期望时间（UTC+8），并留下收取回复的邮箱。</p>
      <div data-request-content>
        <form class="booking-form" method="post">
          <fieldset class="booking-fields">
            <div class="booking-time-fields">
              <label>日期<select name="date" required disabled><option value="">选择日期</option></select></label>
              <label>开始时间<select name="startAt" required disabled><option value="">选择时间</option></select></label>
              <label>时长<select name="duration" required disabled><option value="">选择时长</option></select></label>
            </div>
            <p class="booking-choice" data-choice aria-live="polite">尚未选择时间</p>
            <p class="booking-visitor-time" data-visitor-time hidden></p>
            <div class="booking-contact-fields">
              <label>姓名<input name="name" maxlength="80" autocomplete="name" required></label>
              <label>邮箱<input name="email" type="email" maxlength="254" autocomplete="email" required></label>
              <label>见面方式<select name="meetingType"><option value="online">线上</option><option value="in-person">线下</option></select></label>
            </div>
            <label>备注（选填）<textarea name="notes" rows="3" maxlength="1000" placeholder="可以说明见面的主题或其他合适的时间"></textarea></label>
            <label class="booking-honeypot" aria-hidden="true">请留空<input name="website" tabindex="-1" autocomplete="off"></label>
          </fieldset>
          <p class="booking-caption" data-request-state></p>
          <div class="booking-actions">
            <button class="primary" type="submit" disabled>提交申请</button>
            <button class="secondary" type="button" data-copy-request>复制申请文字</button>
          </div>
          <p class="booking-message" data-request-message role="status" aria-live="polite"></p>
          <label class="booking-manual-copy" data-manual-copy hidden>请手动复制<textarea readonly rows="5"></textarea></label>
        </form>
      </div>
    </section>` : ''}`;

  const calendar = root.querySelector<HTMLElement>('[data-calendar]');
  const feedback = root.querySelector<HTMLElement>('[data-calendar-message]')!;
  const range = root.querySelector<HTMLElement>('[data-week-range]')!;
  const periodNote = root.querySelector<HTMLElement>('[data-period-note]')!;
  const previous = root.querySelector<HTMLButtonElement>('[data-calendar-step="-1"]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-calendar-step="1"]')!;
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-calendar-view]')];
  const form = root.querySelector<HTMLFormElement>('form');
  const dateField = form?.querySelector<HTMLSelectElement>('[name="date"]');
  const timeField = form?.querySelector<HTMLSelectElement>('[name="startAt"]');
  const durationField = form?.querySelector<HTMLSelectElement>('[name="duration"]');
  const submitButton = form?.querySelector<HTMLButtonElement>('[type="submit"]');
  const fieldset = form?.querySelector<HTMLFieldSetElement>('fieldset');
  const requestState = root.querySelector<HTMLElement>('[data-request-state]');
  const choice = root.querySelector<HTMLElement>('[data-choice]');
  const visitorTime = root.querySelector<HTMLElement>('[data-visitor-time]');
  const message = root.querySelector<HTMLElement>('[data-request-message]');
  const manualCopy = root.querySelector<HTMLElement>('[data-manual-copy]');

  let alive = true;
  let week: Week | undefined;
  let readAt = 0;
  let weekRequest: AbortController | undefined;
  let weekVerified = false;
  let submitting = false;
  let submitted = false;
  const compactWeek = window.matchMedia('(max-width: 640px)');
  let view: 'week' | 'day' = showCalendar && compactWeek.matches ? 'day' : 'week';
  let visibleDay = '';
  let selectedDate = '';
  let selectedStart = 0;
  let selectedDuration = 60;
  let lastSubmission: { body: string; id: string } | undefined;
  let lastTick = 0;

  const now = () => week ? week.now + performance.now() - readAt : Date.now();
  const isRequest = (slot: Slot) => slot.state === 'request' && slot.startAt > now();
  const availableSlots = (day: Day | undefined) => day?.slots.filter(isRequest) ?? [];
  const durations = () => (week?.durations ?? []).filter(length => !selectedStart || isRequestSlot(selectedStart, length, now()));
  const hasValidSelection = () => selectedStart > now() && durations().includes(selectedDuration)
    && availableSlots(week?.days.find(day => day.date === selectedDate)).some(slot => slot.startAt === selectedStart);

  function showRequestMessage(text: string, error = false) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle('error', error);
  }

  function updateControls() {
    const index = week?.days.findIndex(day => day.date === visibleDay) ?? 0;
    const unit = view === 'day' ? '天' : '周';
    previous.setAttribute('aria-label', `上一${unit}`);
    next.setAttribute('aria-label', `下一${unit}`);
    previous.disabled = submitting || !week || (week.week === 0 && (view === 'week' || index <= 0));
    next.disabled = submitting || !week || (week.week === week.maxWeek && (view === 'week' || index === week.days.length - 1));
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.calendarView === view));
      button.disabled = submitting;
    }
    calendar?.setAttribute('aria-busy', String(!week && Boolean(weekRequest)));
    if (fieldset) fieldset.disabled = submitting;
    if (submitButton) {
      submitButton.disabled = !weekVerified || submitting || !week?.canSubmit || preview || submitted;
      submitButton.textContent = submitting ? '正在提交…' : '提交申请';
    }
    if (requestState) {
      let notice = '申请不占位，请等待邀请人确认。';
      if (preview) notice = '当前为预览，无法提交申请。';
      else if (weekRequest) notice = '正在确认在线申请权限。';
      else if (!weekVerified) notice = '暂时无法确认在线申请权限。可复制申请文字发给对方。';
      else if (!week?.canSubmit) notice = '邀请人暂未开启在线申请。可复制申请文字发给对方。';
      requestState.textContent = notice;
    }
  }

  function syncForm() {
    if (!week || !dateField || !timeField || !durationField || submitted) return;
    const dates = week.days.filter(day => availableSlots(day).length);
    if (!dates.some(day => day.date === selectedDate)) selectedDate = '';
    const slots = availableSlots(dates.find(day => day.date === selectedDate));
    if (!slots.some(slot => slot.startAt === selectedStart)) selectedStart = 0;
    const lengths = durations();
    if (!lengths.includes(selectedDuration)) selectedDuration = lengths.at(-1) ?? 60;
    dateField.innerHTML = '<option value="">选择日期</option>' + dates.map(day => `<option value="${e(day.date)}">${shortDate(day.date)} ${weekdays[week!.days.indexOf(day)]}</option>`).join('');
    timeField.innerHTML = '<option value="">选择时间</option>' + slots.map(slot => `<option value="${slot.startAt}">${time(slot.startAt)}</option>`).join('');
    durationField.innerHTML = lengths.map(length => `<option value="${length}">${length} 分钟</option>`).join('');
    dateField.value = selectedDate;
    timeField.value = selectedStart ? String(selectedStart) : '';
    durationField.value = String(selectedDuration);
    dateField.disabled = !dates.length;
    timeField.disabled = !slots.length;
    durationField.disabled = !lengths.length;
    if (choice) choice.textContent = selectedStart
      ? `已选择 ${shortDate(selectedDate)} ${time(selectedStart)}–${time(selectedStart + selectedDuration * minute)}（UTC+8）`
      : '尚未选择时间';
    if (visitorTime) {
      const localStart = new Date(selectedStart);
      visitorTime.hidden = !selectedStart || localStart.getTimezoneOffset() === -480;
      if (!visitorTime.hidden) {
        const localEnd = new Date(selectedStart + selectedDuration * minute);
        const formatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        visitorTime.textContent = `你的设备时间 ${formatter.format(localStart)} – ${formatter.format(localEnd)}`;
      }
    }
  }

  function drawPeriod(currentDay?: Day) {
    if (!week) return;
    const year = week.weekStart.slice(0, 4);
    if (view === 'day' && currentDay) {
      const weekday = weekdays[week.days.indexOf(currentDay)];
      range.textContent = `${shortDate(currentDay.date)} · ${weekday}`;
      periodNote.textContent = `${currentDay.date.slice(0, 4)} 年${currentDay.date === bookingDate(now()) ? ' · 今天' : ''}`;
      return;
    }
    const last = week.days.at(-1)!.date;
    const lastYear = last.slice(0, 4);
    range.textContent = `${shortDate(week.weekStart)} – ${lastYear === year ? '' : `${lastYear} 年 `}${shortDate(last)}`;
    periodNote.textContent = `${year} 年${week.week === 0 ? ' · 本周' : ''}`;
  }

  function cityOf(day: Day) {
    return weekVerified && showCity && day.date >= bookingDate(now()) && typeof day.city === 'string' ? day.city.trim() : '';
  }

  function weekLocations(days: Day[]) {
    const groups: { city: string; span: number }[] = [];
    for (const day of days) {
      const city = cityOf(day);
      const previousGroup = groups.at(-1);
      if (previousGroup?.city === city) previousGroup.span++;
      else groups.push({ city, span: 1 });
    }
    if (!groups.some(group => group.city)) return '';
    return `<tr class="booking-location-row"><th scope="row">地点</th>${groups.map(group =>
      `<td colspan="${group.span}">${group.city ? `<span class="booking-location-label" title="${e(group.city)}">${pin}<span>${e(group.city)}</span></span>` : ''}</td>`,
    ).join('')}</tr>`;
  }

  function drawCalendar() {
    if (!week) return;
    const instant = now();
    const today = bookingDate(instant);
    const days = week.days;
    const currentDay = days.find(day => day.date === visibleDay) ?? days.find(day => day.date === today) ?? days[0];
    visibleDay = currentDay.date;
    drawPeriod(currentDay);
    if (!calendar) return;
    const selectedEnd = selectedStart + selectedDuration * minute;
    const stateAt = (day: Day, startAt: number): SlotState => {
      const slot = day.slots.find(candidate => candidate.startAt === startAt);
      return startAt <= instant ? 'expired' : slot?.state ?? 'unavailable';
    };
    const inSelection = (startAt: number) => Boolean(selectedStart && startAt >= selectedStart && startAt < selectedEnd);
    const slotMarkup = (day: Day, startAt: number, dayView = false) => {
      const state = stateAt(day, startAt);
      const selected = state === 'request' && inSelection(startAt);
      const first = selected && startAt === selectedStart;
      const last = selected && startAt + step >= selectedEnd;
      const label = `${shortDate(day.date)} ${time(startAt)} ${selected ? '已选择' : stateNames[state]}`;
      const contents = dayView || (state === 'request' && (!selected || first)) ? time(startAt) : state === 'unavailable' ? '–' : '';
      const classes = `booking-slot ${state}${selected ? ' selected' : ''}${first ? ' selection-first' : ''}${last ? ' selection-last' : ''}`;
      return state === 'request' && allowRequest && !submitted
        ? `<button class="${classes}" type="button" data-slot="${startAt}" aria-label="${label}" aria-pressed="${first}">${contents}${first ? '<span aria-hidden="true">✓</span>' : ''}</button>`
        : `<span class="${classes}" role="img" aria-label="${label}">${contents}</span>`;
    };
    const dayLabel = (day: Day, index: number) => `<span class="booking-weekday">${weekdays[index]}</span><span class="booking-date-number">${dateNumber(day.date)}</span>`;
    const current = (day: Day) => day.date === today ? ' aria-current="date"' : '';
    const selection = selectedStart && allowRequest && !submitted
      ? `<div class="booking-range-chip"><span><strong>已选择</strong> ${shortDate(selectedDate)} ${time(selectedStart)}–${time(selectedEnd)}</span><button type="button" class="text-button booking-jump" data-jump>填写申请 ↓</button></div>`
      : '';
    if (view === 'day') {
      const city = cityOf(currentDay);
      const base = dayStart(currentDay.date);
      const periods = [
        { label: '上午', first: 0, count: 6 },
        { label: '下午', first: 6, count: 12 },
        { label: '晚上', first: 18, count: 6 },
      ];
      calendar.innerHTML = `<div class="booking-day-view">
        <div class="booking-days" role="group" aria-label="本周日期">${days.map((day, index) => `<button type="button" data-day="${e(day.date)}" aria-label="${weekdays[index]} ${shortDate(day.date)}" aria-pressed="${day === currentDay}"${current(day)}>${dayLabel(day, index)}</button>`).join('')}</div>
        ${city ? `<div class="booking-day-location"><span>${pin}地点</span><strong>${e(city)}</strong></div>` : ''}
        ${periods.map(period => `<section class="booking-day-period">
          <h3>${period.label} <span>${time(base + period.first * step)}–${time(base + (period.first + period.count) * step)}</span></h3>
          <div class="booking-day-slots">${Array.from({ length: period.count }, (_, index) => slotMarkup(currentDay, base + (period.first + index) * step, true)).join('')}</div>
        </section>`).join('')}
      </div>${selection}`;
      return;
    }
    if (compactWeek.matches) {
      const overview = days.map((day, index) => {
        const city = cityOf(day);
        const base = dayStart(day.date);
        const segments = Array.from({ length: 12 }, (_, hour) => {
          const first = base + 2 * hour * step;
          const halfHours = [first, first + step];
          if (halfHours.some(start => inSelection(start))) return 'selected';
          const states = halfHours.map(start => stateAt(day, start));
          return states.includes('request') ? 'request' : states.every(state => state === 'expired') ? 'expired' : 'unavailable';
        });
        const state = segments.includes('request') || segments.includes('selected') ? '可申请' : segments.every(segment => segment === 'expired') ? '已过期' : '未开放';
        const title = `${weekdays[index]} ${shortDate(day.date)} ${state}${city ? ` ${city}` : ''}，查看当天`;
        return `<button type="button" data-open-day="${e(day.date)}" aria-label="${e(title)}"${current(day)}>
          <span class="booking-overview-date"><strong>${weekdays[index]}</strong>${shortDate(day.date)}${day.date === today ? ' · 今天' : ''}</span>
          <span class="booking-overview-detail">${city ? `<span class="booking-location-label">${pin}<span>${e(city)}</span></span>` : ''}<span class="booking-overview-track" aria-hidden="true">${segments.map(segment => `<i class="${segment}"></i>`).join('')}</span></span>
          <span class="booking-overview-state">${state}<span aria-hidden="true">›</span></span>
        </button>`;
      }).join('');
      calendar.innerHTML = `<div class="booking-week-overview" role="group" aria-label="本周各日概览">${overview}</div>${selection}`;
      return;
    }
    const starts = days.map(day => dayStart(day.date));
    const rows = Array.from({ length: 24 }, (_, row) => {
      const hour = row % 2 === 0;
      const clock = time(starts[0] + row * step);
      return `<tr${hour ? ' class="booking-hour"' : ''}><th scope="row"${hour ? '' : ' class="booking-half-hour"'}>${clock}</th>${days.map((day, index) => `<td${day.date === today ? ' class="booking-today-column"' : ''}>${slotMarkup(day, starts[index] + row * step)}</td>`).join('')}</tr>`;
    }).join('');
    calendar.innerHTML = `
      <table class="booking-week-grid" aria-label="工作日九点至二十一点的申请时段">
        <thead><tr><th scope="col">时间</th>${days.map((day, index) => `<th scope="col"${day.date === today ? ' class="booking-today-column"' : ''}>
          <button type="button" data-open-day="${e(day.date)}" aria-label="${weekdays[index]} ${shortDate(day.date)}，查看当天"${current(day)}>${dayLabel(day, index)}${day.date === today ? '<span class="booking-today-label">今天</span>' : ''}</button>
        </th>`).join('')}</tr>${weekLocations(days)}</thead>
        <tbody>${rows}</tbody>
      </table>${selection}`;
  }

  function syncSelection() { syncForm(); drawCalendar(); updateControls(); }

  function setWeek(data: Week, edge?: 'first' | 'last') {
    const sameWeek = week?.weekStart === data.weekStart;
    const focused = sameWeek ? calendar?.querySelector('button:focus') : undefined;
    const focusKey = focused?.getAttributeNames().find(name => name.startsWith('data-'));
    if (!sameWeek) {
      selectedDate = '';
      selectedStart = 0;
      visibleDay = edge ? data.days[edge === 'first' ? 0 : data.days.length - 1].date : '';
    }
    week = data;
    readAt = performance.now();
    lastTick = Math.floor(now() / step);
    syncSelection();
    if (focused && focusKey) {
      const value = CSS.escape(focused.getAttribute(focusKey)!);
      calendar?.querySelector<HTMLButtonElement>(`button[${focusKey}="${value}"]`)?.focus({ preventScroll: true });
    }
  }

  async function loadWeek(offset: number, edge?: 'first' | 'last') {
    if (!alive || submitting) return;
    weekRequest?.abort();
    const request = new AbortController();
    weekRequest = request;
    weekVerified = false;
    feedback.textContent = week ? '正在核对本周信息…' : '正在读取周历…';
    if (week) {
      const generic = requestWeek(Math.floor(now()), offset, allowRequest);
      setWeek({ ...generic, canSubmit: false }, edge);
    } else updateControls();
    try {
      const response = await send(`/invite/calendar?week=${offset}`, undefined, request.signal);
      if (!alive || weekRequest !== request) return;
      const data = readWeek(response);
      weekVerified = true;
      feedback.textContent = '';
      setWeek(data, edge);
    } catch (error) {
      if (!alive || weekRequest !== request) return;
      if (error instanceof InvitationError && [401, 403, 404].includes(error.status)) { unavailable(); return; }
      feedback.textContent = week ? '暂时无法核对本周信息，已显示基础时段。' : '暂时无法读取周历。';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重试';
      retry.addEventListener('click', () => void loadWeek(offset, edge));
      feedback.append(retry);
    } finally {
      if (weekRequest === request) {
        weekRequest = undefined;
        if (alive) updateControls();
      }
    }
  }

  function choose(startAt: number) {
    const date = bookingDate(startAt);
    if (!availableSlots(week?.days.find(day => day.date === date)).some(slot => slot.startAt === startAt)) return;
    selectedDate = date; visibleDay = date; selectedStart = startAt;
    showRequestMessage('');
    syncSelection();
  }

  function showDay(date: string) {
    if (!week?.days.some(day => day.date === date)) return;
    view = 'day';
    visibleDay = date;
    if (!selectedStart && !submitted) selectedDate = date;
    syncSelection();
  }

  function move(delta: -1 | 1) {
    if (!week || submitting) return;
    if (view === 'day') {
      const day = week.days[week.days.findIndex(item => item.date === visibleDay) + delta];
      if (day) { showDay(day.date); return; }
    }
    const offset = week.week + delta;
    if (offset >= 0 && offset <= week.maxWeek) void loadWeek(offset, view === 'day' ? (delta === 1 ? 'first' : 'last') : undefined);
  }

  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  for (const button of viewButtons) button.addEventListener('click', () => {
    view = button.dataset.calendarView === 'day' ? 'day' : 'week';
    drawCalendar();
    updateControls();
  });
  calendar?.addEventListener('click', event => {
    if (submitting) return;
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target) return;
    const date = target.dataset.day ?? target.dataset.openDay;
    if (date) {
      showDay(date);
      calendar.querySelector<HTMLButtonElement>(`[data-day="${visibleDay}"]`)?.focus({ preventScroll: true });
    } else if (target.dataset.slot) {
      const startAt = Number(target.dataset.slot);
      choose(startAt);
      calendar.querySelector<HTMLButtonElement>(`[data-slot="${startAt}"]`)?.focus({ preventScroll: true });
    } else if (target.hasAttribute('data-jump')) {
      root.querySelector<HTMLElement>('#booking-request-title')?.focus();
    }
  });

  dateField?.addEventListener('change', () => {
    selectedDate = dateField.value; visibleDay = selectedDate || visibleDay; selectedStart = 0;
    syncSelection();
  });
  timeField?.addEventListener('change', () => {
    if (timeField.value) choose(Number(timeField.value));
    else { selectedStart = 0; syncSelection(); }
  });
  durationField?.addEventListener('change', () => { selectedDuration = Number(durationField.value); syncSelection(); });

  function readDraft() {
    const fields = new FormData(form!);
    const field = (name: string) => String(fields.get(name) ?? '').trim();
    return {
      name: field('name'), email: field('email'), startAt: selectedStart, duration: selectedDuration,
      meetingType: field('meetingType'), notes: field('notes'), website: field('website'),
    };
  }

  async function submitAttempt(draft: ReturnType<typeof readDraft>, submissionId: string) {
    if (!alive || !form || !week || !weekVerified || submitting || submitted) return;
    submitting = true;
    let refreshWeek: number | undefined;
    showRequestMessage('正在提交申请…');
    updateControls();
    try {
      const response = await send('/invite/requests', { ...draft, submissionId });
      if (!alive) return;
      if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) throw new Error('Invalid confirmation');
      submitted = true;
      lastSubmission = undefined;
      form.reset();
      root.querySelector<HTMLElement>('[data-request-content]')!.innerHTML = '<div class="booking-receipt" role="status"><strong>已收到申请，等待确认</strong><p>邀请人确认后会通过邮件回复。</p></div>';
      drawCalendar();
    } catch (error) {
      if (!alive) return;
      if (error instanceof InvitationError && (error.status === 401 || error.status === 404)) { unavailable(); return; }
      if (error instanceof InvitationError && error.status === 429) {
        showRequestMessage('申请操作过于频繁，请稍后再试。也可复制申请文字。', true);
      } else if (error instanceof InvitationError && error.code === 'REQUESTS_DISABLED') {
        week.canSubmit = false;
        showRequestMessage('在线申请暂未开启。可复制申请文字发给邀请人。', true);
      } else if (error instanceof InvitationError && error.code === 'SLOT_UNAVAILABLE') {
        selectedStart = 0;
        refreshWeek = week.week;
        showRequestMessage('这个时段已经不能申请了，请选择其他时间。', true);
      } else if (error instanceof InvitationError && error.code === 'SUBMISSION_CHANGED') {
        lastSubmission = undefined;
        showRequestMessage('表单内容与原申请不一致，请核对后重新提交。', true);
      } else if (error instanceof InvitationError && error.status === 400) {
        syncSelection();
        showRequestMessage('请检查所选时间和表单信息后重试。', true);
      } else {
        showRequestMessage('暂时无法确认提交结果。可重新确认这次提交，或复制申请文字发给邀请人。', true);
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新确认提交';
        retry.addEventListener('click', () => void submitAttempt(draft, submissionId));
        message?.append(retry);
      }
    } finally {
      submitting = false;
      if (alive) updateControls();
      if (refreshWeek !== undefined) void loadWeek(refreshWeek);
    }
  }

  form?.addEventListener('submit', event => {
    event.preventDefault();
    if (!allowRequest || preview || !week?.canSubmit || !weekVerified || submitting || submitted) return;
    if (!hasValidSelection()) { syncSelection(); showRequestMessage('请选择仍可申请的日期、时间和时长。', true); return; }
    const draft = readDraft();
    const email = parseEmailAddress(draft.email);
    if (!draft.name || !email) { showRequestMessage('请填写姓名和有效邮箱。', true); return; }
    draft.email = email;
    const body = JSON.stringify(draft);
    if (lastSubmission?.body !== body) lastSubmission = { body, id: crypto.randomUUID() };
    void submitAttempt(draft, lastSubmission.id);
  });

  root.querySelector<HTMLButtonElement>('[data-copy-request]')?.addEventListener('click', async () => {
    if (submitting || submitted) return;
    if (!hasValidSelection()) { showRequestMessage('请先选择想申请的时间。', true); return; }
    const draft = readDraft();
    const text = [
      '你好，我想申请见面时间。',
      `${selectedDate} ${time(selectedStart)}–${time(selectedStart + selectedDuration * minute)}（UTC+8）`,
      `见面方式：${draft.meetingType === 'in-person' ? '线下' : '线上'}`,
      `姓名：${draft.name}`, `邮箱：${draft.email}`, ...(draft.notes ? [`备注：${draft.notes}`] : []),
    ].join('\n');
    const copied = await copyText(text);
    if (!alive || submitted) return;
    if (manualCopy) {
      manualCopy.hidden = copied;
      const field = manualCopy.querySelector('textarea')!;
      field.value = copied ? '' : text;
      if (!copied) { field.focus(); field.select(); }
    }
    showRequestMessage(copied ? '申请文字已复制，可发给邀请人。' : '请手动复制下方的申请文字。');
  });

  function refreshClock() {
    if (!alive || !week || submitting || document.hidden) return;
    if (week.days.at(-1)!.date < bookingDate(now())) { void loadWeek(0); return; }
    const tick = Math.floor(now() / step);
    if (tick !== lastTick) { lastTick = tick; syncSelection(); }
  }
  const redrawWeek = () => { if (view === 'week') drawCalendar(); };
  if (showCalendar) compactWeek.addEventListener('change', redrawWeek);
  const timer = window.setInterval(refreshClock, 30_000);
  document.addEventListener('visibilitychange', refreshClock);
  void loadWeek(0);
  return () => {
    alive = false;
    weekRequest?.abort();
    weekRequest = undefined;
    lastSubmission = undefined;
    if (showCalendar) compactWeek.removeEventListener('change', redrawWeek);
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', refreshClock);
  };
}
