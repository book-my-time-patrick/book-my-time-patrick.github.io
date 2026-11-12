import './invitation-booking.css';
import { bookingDate, isRequestSlot, parseEmailAddress, requestWeek, REQUEST_DURATIONS } from '../../shared/booking';
import type { SlotState } from '../../shared/booking';
import { copyText, escapeHtml as e } from './ui';

type Availability = 'available' | 'busy' | 'blocked';
type BookingMode = 'request' | 'direct';
type CalendarState = SlotState | Exclude<Availability, 'blocked'>;
interface Slot { startAt: number; state: SlotState; availability?: Availability; bookableDurations?: number[]; requestDurations?: number[] }
interface Day { date: string; slots: Slot[]; city?: string }
interface OpenSession {
  id: string; title: string; emoji: string; color: 'blue' | 'plum' | 'green' | 'amber';
  startAt: number; endAt: number; location: string; description: string; mapUrl: string;
  capacity: number | null; remaining: number | null; approvalRequired: boolean; emailRequired: boolean;
}
interface Week {
  now: number; week: number; maxWeek: number; weekStart: string; canSubmit: boolean;
  days: Day[]; durations: readonly number[];
  availability?: 'ready' | 'unavailable'; canBook?: boolean; validUntil?: number;
  openSessions?: OpenSession[];
}
interface Options {
  showCalendar: boolean; showCity: boolean; hideBusy: boolean; allowRequest: boolean; allowDirect: boolean; allowOpen: boolean; preview: boolean;
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
const stateNames: Record<CalendarState, string> = { expired: '已过期', request: '可申请', unavailable: '未开放', available: '空闲', busy: '已占用' };
const baseStates = ['expired', 'request', 'unavailable'];
const isDuration = (duration: number) => REQUEST_DURATIONS.some(length => length === duration);
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
    || !data.durations.length || data.durations.some(duration => !isDuration(duration))
    || (data.availability !== undefined && !['ready', 'unavailable'].includes(data.availability))
    || (data.canBook !== undefined && typeof data.canBook !== 'boolean')
    || (data.validUntil !== undefined && !Number.isSafeInteger(data.validUntil))) {
    throw new Error('Invalid calendar');
  }
  for (const day of data.days) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(dayStart(day.date))
      || !Array.isArray(day.slots) || day.slots.length > 24
      || day.slots.some(slot => !slot || !Number.isSafeInteger(slot.startAt) || !baseStates.includes(slot.state)
        || slot.startAt < dayStart(day.date) || slot.startAt >= dayStart(day.date) + 24 * step
        || slot.startAt % step !== 0
        || (slot.availability !== undefined && !['available', 'busy', 'blocked'].includes(slot.availability))
        || (slot.bookableDurations !== undefined && (!Array.isArray(slot.bookableDurations)
          || slot.bookableDurations.some(duration => !isDuration(duration))))
        || (slot.requestDurations !== undefined && (!Array.isArray(slot.requestDurations)
          || slot.requestDurations.some(duration => !isDuration(duration)))))) throw new Error('Invalid calendar day');
  }
  if (data.weekStart !== data.days[0].date) throw new Error('Invalid week start');
  if (data.openSessions !== undefined && (!Array.isArray(data.openSessions) || data.openSessions.length > 200
    || data.openSessions.some(session => !session || typeof session.id !== 'string' || !session.id || session.id.length > 128
      || !Number.isSafeInteger(session.startAt) || !Number.isSafeInteger(session.endAt) || session.endAt <= session.startAt
      || !Number.isFinite(new Date(session.startAt).getTime()) || !Number.isFinite(new Date(session.endAt).getTime())
      || !['blue', 'plum', 'green', 'amber'].includes(session.color)
      || ['title', 'emoji', 'location', 'description', 'mapUrl'].some(field => typeof session[field as keyof OpenSession] !== 'string')
      || typeof session.approvalRequired !== 'boolean' || typeof session.emailRequired !== 'boolean'
      || (session.capacity !== null && (!Number.isSafeInteger(session.capacity) || session.capacity < 1))
      || (session.remaining !== null && (!Number.isSafeInteger(session.remaining) || session.remaining < 0))))) throw new Error('Invalid open sessions');
  return data;
}

export function renderInvitationBooking(root: HTMLElement, options: Options): () => void {
  const { showCalendar, showCity, hideBusy, allowRequest, allowDirect, allowOpen, preview, send, unavailable } = options;
  const hasCalendar = showCalendar || allowOpen;
  const hasForm = allowRequest || allowDirect;
  const navigation = `<div class="booking-period-nav" aria-label="切换日期范围" role="group">
    <div class="booking-period" aria-live="polite">
      <span data-period-note class="booking-period-note"></span>
      <p class="booking-week-range" data-week-range>本周</p>
    </div>
    <div class="booking-period-controls">
      <button class="booking-nav-arrow" type="button" data-calendar-step="-1" aria-label="上一周" disabled><span aria-hidden="true">‹</span></button>
      ${hasCalendar ? '<button class="booking-nav-today" type="button" data-calendar-today disabled>今天</button>' : ''}
      <button class="booking-nav-arrow" type="button" data-calendar-step="1" aria-label="下一周" disabled><span aria-hidden="true">›</span></button>
    </div>
  </div>`;
  const weekFeedback = '<p class="booking-feedback" data-calendar-message role="status" aria-live="polite"></p>';
  root.innerHTML = `
    ${hasCalendar ? `<section class="invitation-card booking-card booking-calendar-card" aria-labelledby="booking-calendar-title">
      <div class="booking-section-head booking-calendar-head">
        <h2 id="booking-calendar-title">预约日历</h2>
        <div class="booking-view-toggle" role="group" aria-label="日历视图">
          <button type="button" data-calendar-view="week" aria-pressed="false">周视图</button>
          <button type="button" data-calendar-view="day" aria-pressed="false">日视图</button>
        </div>
      </div>
      ${navigation}
      ${weekFeedback}
      <div class="booking-legend" aria-label="周历图例">
        ${hideBusy ? '' : '<span data-legend-busy hidden><i class="booking-key busy" aria-hidden="true"></i>已占用</span>'}
        ${hasForm ? '<span><i class="booking-key selected" aria-hidden="true">✓</i>已选择</span>' : ''}
        ${allowOpen ? '<span><i class="booking-key booking-open-key" aria-hidden="true">◇</i>开放局</span>' : ''}
        <span class="booking-legend-zone">UTC+8</span>
      </div>
      <p class="booking-calendar-hint" data-calendar-caption hidden></p>
      <div data-calendar class="booking-calendar" aria-busy="true"></div>
    </section>` : ''}
    ${hasForm ? `<section class="invitation-card booking-card" data-booking-actions aria-labelledby="booking-request-title"${allowRequest ? '' : ' hidden'}>
      <div class="booking-section-head"><div><p class="eyebrow">BOOK A TIME</p><h2 id="booking-request-title" tabindex="-1">预约其他时间</h2></div><span class="booking-zone" data-mode-note>待邀请人确认</span></div>
      ${hasCalendar ? '' : navigation + weekFeedback}
      ${allowRequest && allowDirect ? `<div class="booking-view-toggle booking-mode-toggle" data-booking-modes role="group" aria-label="预约方式" hidden>
        <button type="button" data-booking-mode="request" aria-pressed="true">邮件申请</button>
        <button type="button" data-booking-mode="direct" aria-pressed="false">直接预约</button>
      </div>` : ''}
      <p class="booking-caption" data-mode-caption>请选择工作日的期望时间（UTC+8），并留下收取回复的邮箱。</p>
      <div data-request-content>
        <form class="booking-form" data-request-form method="post">
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
    </section>` : ''}
    ${allowOpen ? '<dialog class="booking-open-dialog invitation-card" aria-labelledby="booking-open-title"><div data-open-content></div></dialog>' : ''}`;

  const calendar = root.querySelector<HTMLElement>('[data-calendar]');
  const feedback = root.querySelector<HTMLElement>('[data-calendar-message]')!;
  const range = root.querySelector<HTMLElement>('[data-week-range]')!;
  const periodNote = root.querySelector<HTMLElement>('[data-period-note]')!;
  const previous = root.querySelector<HTMLButtonElement>('[data-calendar-step="-1"]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-calendar-step="1"]')!;
  const todayButton = root.querySelector<HTMLButtonElement>('[data-calendar-today]');
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-calendar-view]')];
  const actionCard = root.querySelector<HTMLElement>('[data-booking-actions]');
  const actionTitle = root.querySelector<HTMLElement>('#booking-request-title');
  const modeToggle = root.querySelector<HTMLElement>('[data-booking-modes]');
  const modeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-booking-mode]')];
  const modeNote = root.querySelector<HTMLElement>('[data-mode-note]');
  const modeCaption = root.querySelector<HTMLElement>('[data-mode-caption]');
  const calendarCaption = root.querySelector<HTMLElement>('[data-calendar-caption]');
  const busyLegend = root.querySelector<HTMLElement>('[data-legend-busy]');
  const form = root.querySelector<HTMLFormElement>('[data-request-form]');
  const openDialog = root.querySelector<HTMLDialogElement>('.booking-open-dialog');
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
  const copyButton = root.querySelector<HTMLButtonElement>('[data-copy-request]');

  let alive = true;
  let week: Week | undefined;
  let readAt = 0;
  let weekRequest: AbortController | undefined;
  let weekVerified = false;
  let expiryTimer: number | undefined;
  let directOffered = false;
  let mode: BookingMode = allowRequest ? 'request' : 'direct';
  let submitting = false;
  let submitted = false;
  const compactWeek = window.matchMedia('(max-width: 640px)');
  let view: 'week' | 'day' = hasCalendar && compactWeek.matches ? 'day' : 'week';
  let visibleDay = '';
  let selectedDate = '';
  let selectedStart = 0;
  let selectedDuration = 60;
  const lastSubmissions: Partial<Record<BookingMode, { body: string; id: string }>> = {};
  let lastTick = 0;
  let selectedOpen: OpenSession | undefined;
  let openSubmitting = false;
  let openReceipt = false;
  let calendarDownload: string | undefined;
  const openSubmissions = new Map<string, { body: string; id: string }>();

  const now = () => week ? week.now + performance.now() - readAt : Date.now();
  const openSessions = () => allowOpen && weekVerified ? (week?.openSessions ?? []).filter(session => session.startAt > now()) : [];
  const availabilityReady = () => showCalendar && weekVerified && (week?.availability === 'ready' || week?.canBook === true)
    && (week.validUntil === undefined || now() < week.validUntil);
  const directSelectable = () => allowDirect && availabilityReady() && (preview || week?.canBook === true);
  const canChoose = (slot: Slot) => slot.startAt > now() && (mode === 'request'
    ? allowRequest && slot.state === 'request'
    : directSelectable() && slot.availability === 'available' && Boolean(slot.bookableDurations?.length));
  const availableSlots = (day: Day | undefined) => day?.slots.filter(canChoose) ?? [];
  const canSubmitCurrentMode = () => weekVerified && (mode === 'request' ? allowRequest && week?.canSubmit : allowDirect && availabilityReady() && week?.canBook);
  function durations() {
    const lengths = week?.durations ?? [];
    if (mode === 'direct') {
      if (!directSelectable()) return [];
      if (!selectedStart) return lengths;
      const slot = week?.days.find(day => day.date === selectedDate)?.slots.find(item => item.startAt === selectedStart);
      return lengths.filter(length => slot?.bookableDurations?.includes(length));
    }
    const slot = week?.days.find(day => day.date === selectedDate)?.slots.find(item => item.startAt === selectedStart);
    return lengths.filter(length => !selectedStart || (isRequestSlot(selectedStart, length, now())
      && (slot?.requestDurations === undefined || slot.requestDurations.includes(length))));
  }
  const hasValidSelection = () => selectedStart > now() && durations().includes(selectedDuration)
    && availableSlots(week?.days.find(day => day.date === selectedDate)).some(slot => slot.startAt === selectedStart);

  function showRequestMessage(text: string, error = false) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle('error', error);
  }

  function updateControls() {
    const busy = submitting || openSubmitting;
    const index = week?.days.findIndex(day => day.date === visibleDay) ?? 0;
    const unit = view === 'day' ? '天' : '周';
    previous.setAttribute('aria-label', `上一${unit}`);
    next.setAttribute('aria-label', `下一${unit}`);
    previous.disabled = busy || !week || (week.week === 0 && (view === 'week' || index <= 0));
    next.disabled = busy || !week || (week.week === week.maxWeek && (view === 'week' || index === week.days.length - 1));
    if (todayButton) todayButton.disabled = busy || !week || (week.week === 0 && (view === 'week' || visibleDay === bookingDate(now())));
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.calendarView === view));
      button.disabled = busy;
    }
    if (actionCard) actionCard.hidden = !allowRequest && !directOffered;
    if (modeToggle) modeToggle.hidden = !directOffered || submitted;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.bookingMode === mode));
      button.disabled = busy;
    }
    const direct = mode === 'direct';
    if (actionTitle) actionTitle.textContent = direct ? '直接预约' : '预约其他时间';
    if (modeNote) modeNote.textContent = direct ? '提交后立即确认' : '待邀请人确认';
    if (modeCaption) modeCaption.textContent = direct
      ? '请选择空闲时段（UTC+8），并留下收取预约确认的邮箱。'
      : '请选择工作日的期望时间（UTC+8），并留下收取回复的邮箱。';
    if (calendarCaption) {
      let caption = '';
      if (direct && directSelectable()) caption = '点按可预约的空白时段选择时间。';
      else if (allowRequest) caption = '点按未来工作日的时段提出申请，由邀请人确认。';
      else if (showCalendar && week && !weekRequest && !availabilityReady()) caption = '忙闲信息暂未同步。';
      if (allowOpen) caption += `${caption ? ' ' : ''}点按开放局查看详情并报名。`;
      calendarCaption.textContent = caption;
      calendarCaption.hidden = !caption || submitted;
    }
    if (busyLegend) busyLegend.hidden = !availabilityReady();
    calendar?.setAttribute('aria-busy', String(!week && Boolean(weekRequest)));
    if (fieldset) fieldset.disabled = submitting;
    if (submitButton) {
      submitButton.disabled = !canSubmitCurrentMode() || submitting || preview || submitted;
      submitButton.textContent = submitting ? '正在提交…' : direct ? '确认预约' : '提交申请';
    }
    if (copyButton) copyButton.hidden = direct;
    if (direct && manualCopy) manualCopy.hidden = true;
    if (requestState) {
      let notice = direct ? '提交成功后，预约立即生效。' : '申请不占位，请等待邀请人确认。';
      if (preview) notice = '当前为预览，无法提交。';
      else if (weekRequest) notice = direct ? '正在核对空闲时段。' : '正在确认在线申请权限。';
      else if (!canSubmitCurrentMode()) notice = direct ? '暂时无法直接预约。' : weekVerified
        ? '邀请人暂未开启在线申请。可复制申请文字发给对方。'
        : '暂时无法确认在线申请权限。可复制申请文字发给对方。';
      requestState.textContent = notice;
    }
    updateOpenControls();
  }

  function syncForm() {
    if (!week || !dateField || !timeField || !durationField || submitted) return;
    if (mode === 'direct' && !weekVerified && selectedStart) {
      dateField.disabled = true;
      timeField.disabled = true;
      durationField.disabled = true;
      return;
    }
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
      range.textContent = `${shortDate(currentDay.date)} · ${weekday}${currentDay.date === bookingDate(now()) ? ' · 今天' : ''}`;
      periodNote.textContent = `${currentDay.date.slice(0, 4)} 年 ${Number(currentDay.date.slice(5, 7))} 月`;
      return;
    }
    const last = week.days.at(-1)!.date;
    const lastYear = last.slice(0, 4);
    range.textContent = `${shortDate(week.weekStart)} – ${lastYear === year ? '' : `${lastYear} 年 `}${shortDate(last)}`;
    periodNote.textContent = `${year} 年 ${Number(week.weekStart.slice(5, 7))} 月`;
  }

  function cityOf(day: Day) {
    return weekVerified && showCity && day.date >= bookingDate(now()) && typeof day.city === 'string' ? day.city.trim() : '';
  }

  function cityLabel(day: Day) {
    const city = cityOf(day);
    return city ? `<span class="booking-location-label" title="${e(city)}">${pin}<span>${e(city)}</span></span>` : '';
  }

  function sessionCapacity(session: OpenSession) {
    return session.remaining === null ? '名额不限' : session.remaining === 0 ? '已约满' : `剩余 ${session.remaining} 个名额`;
  }

  function openSessionList(days: Day[]) {
    if (!allowOpen || !weekVerified) return '';
    const sessions = openSessions().filter(session => days.some(day => day.date === bookingDate(session.startAt)));
    if (!sessions.length) return showCalendar || allowRequest ? '' : '<p class="booking-caption">这段日期暂时没有开放局。</p>';
    return `<div class="booking-open-list" aria-label="开放局列表">${sessions.map(session => `<button type="button"
      class="booking-open-card booking-open-slot--${session.color}${session.remaining === 0 ? ' booking-open-full' : ''}"
      data-open-session="${e(session.id)}"${session.remaining === 0 ? ' disabled' : ''}>
      <strong>${e(session.emoji)} ${e(session.title)}</strong>
      <span>${shortDate(bookingDate(session.startAt))} ${time(session.startAt)}–${time(session.endAt)}</span>
      <span class="booking-open-capacity">${sessionCapacity(session)}${session.approvalRequired ? ' · 需确认' : ''}</span>
    </button>`).join('')}</div>`;
  }

  function showOpenMessage(text: string, error = false) {
    const status = openDialog?.querySelector<HTMLElement>('[data-open-message]');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function updateOpenControls() {
    if (!openDialog?.open || !selectedOpen || openReceipt) return;
    const current = openSessions().find(session => session.id === selectedOpen!.id);
    const fields = openDialog.querySelector<HTMLFieldSetElement>('fieldset');
    const button = openDialog.querySelector<HTMLButtonElement>('[type="submit"]');
    const close = openDialog.querySelector<HTMLButtonElement>('[data-open-close]');
    const capacity = openDialog.querySelector<HTMLElement>('[data-open-capacity]');
    if (fields) fields.disabled = openSubmitting;
    if (button) {
      button.disabled = openSubmitting || preview || !current || current.remaining === 0;
      button.textContent = openSubmitting ? '正在提交…' : selectedOpen.approvalRequired ? '提交预约申请' : '确认预约';
    }
    if (close) close.disabled = openSubmitting;
    if (capacity) capacity.textContent = current ? sessionCapacity(current) : weekRequest ? '正在核对场次信息…' : '这场活动暂时无法预约。';
  }

  function showOpenSession(id: string) {
    const session = openSessions().find(item => item.id === id);
    if (!openDialog || !session || session.remaining === 0 || submitting || openSubmitting) return;
    selectedOpen = session;
    openReceipt = false;
    if (calendarDownload) URL.revokeObjectURL(calendarDownload);
    calendarDownload = undefined;
    let mapUrl = '';
    try {
      const url = new URL(session.mapUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) mapUrl = url.href;
    } catch { /* A map link is optional. */ }
    openDialog.innerHTML = `<div class="booking-section-head"><h2 id="booking-open-title">${e(session.emoji)} ${e(session.title)}</h2>
      <button class="text-button" type="button" data-open-close aria-label="关闭开放局详情">关闭</button></div>
      <div class="booking-open-details">
        <p>${shortDate(bookingDate(session.startAt))} ${time(session.startAt)}–${time(session.endAt)}（UTC+8）</p>
        ${session.location ? `<p>${e(session.location)}</p>` : ''}
        ${session.description ? `<p class="booking-open-description">${e(session.description)}</p>` : ''}
        ${mapUrl ? `<p><a href="${e(mapUrl)}" target="_blank" rel="noopener noreferrer">查看地图 ↗</a></p>` : ''}
        <p class="booking-open-capacity" data-open-capacity>${sessionCapacity(session)}</p>
      </div>
      <form class="booking-form" data-open-form method="post">
        <fieldset class="booking-fields">
          <label>姓名<input name="name" required maxlength="80" autocomplete="name"></label>
          <label>邮箱${session.emailRequired ? '' : '（选填）'}<input name="email" type="email" maxlength="254" autocomplete="email"${session.emailRequired ? ' required' : ''}></label>
          <label class="booking-honeypot" aria-hidden="true">请留空<input name="website" tabindex="-1" autocomplete="off"></label>
        </fieldset>
        <p class="booking-caption">${preview ? '当前为预览，无法提交。' : session.approvalRequired ? '提交后请等待邀请人确认。' : '确认后预约立即生效。'}${!preview && !session.emailRequired ? ' 留下邮箱可收到确认通知。' : ''}</p>
        <div class="booking-actions"><button class="primary" type="submit">${session.approvalRequired ? '提交预约申请' : '确认预约'}</button></div>
        <p class="booking-message" data-open-message role="status" aria-live="polite"></p>
      </form>`;
    if (!openDialog.open) openDialog.showModal();
    updateOpenControls();
  }

  async function submitOpenSession(session: OpenSession, draft: { name: string; email?: string; website: string }, submissionId: string) {
    if (!alive || !openDialog || !weekVerified || preview || openSubmitting || openReceipt) return;
    openSubmitting = true;
    showOpenMessage('正在提交…');
    updateControls();
    let refresh = false;
    try {
      const result = await send(`/invite/open/${encodeURIComponent(session.id)}`, { ...draft, submissionId });
      if (!alive) return;
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
        || !('status' in result) || !['confirmed', 'pending'].includes(String(result.status))) throw new Error('Invalid confirmation');
      openReceipt = true;
      openSubmissions.delete(session.id);
      const confirmed = result.status === 'confirmed';
      if (confirmed && 'calendar' in result && typeof result.calendar === 'string' && result.calendar.length < 128 * 1024
        && result.calendar.startsWith('BEGIN:VCALENDAR')) {
        calendarDownload = URL.createObjectURL(new Blob([result.calendar], { type: 'text/calendar;charset=utf-8' }));
      }
      const mail = confirmed && draft.email ? 'mailStatus' in result && result.mailStatus === 'sent'
        ? '确认通知已发出。' : '邮件暂未确认发出，请保留当前结果。' : '';
      openDialog.innerHTML = `<div class="booking-section-head"><h2 id="booking-open-title">${confirmed ? '预约已确认' : '已收到预约申请'}</h2>
        <button class="text-button" type="button" data-open-close>关闭</button></div>
        <div class="booking-receipt booking-open-receipt" role="status"><strong>${e(session.emoji)} ${e(session.title)}</strong>
          <p>${shortDate(bookingDate(session.startAt))} ${time(session.startAt)}–${time(session.endAt)}（UTC+8）</p>
          <p>${confirmed ? '预约已生效。' : '请等待邀请人确认。'}${mail}</p>
          ${calendarDownload ? `<p><a class="text-button" href="${e(calendarDownload)}" download="appointment.ics">添加到日历</a></p>` : ''}
        </div>`;
      refresh = true;
    } catch (error) {
      if (!alive) return;
      if (error instanceof InvitationError && error.status === 401) { unavailable(); return; }
      if (error instanceof InvitationError && error.code === 'OPEN_FULL') {
        showOpenMessage('这场活动刚刚约满，请选择其他场次。', true);
        refresh = true;
      } else if (error instanceof InvitationError && (error.status === 404 || error.code === 'SLOT_UNAVAILABLE')) {
        showOpenMessage('这场活动已无法预约，请选择其他场次。', true);
        refresh = true;
      } else if (error instanceof InvitationError && error.code === 'REQUESTS_DISABLED') {
        showOpenMessage('邀请人暂未开放在线预约，请稍后再试。', true);
        refresh = true;
      } else if (error instanceof InvitationError && error.status === 429) {
        showOpenMessage('预约操作过于频繁，请稍后再试。', true);
      } else if (error instanceof InvitationError && error.code === 'SUBMISSION_CHANGED') {
        openSubmissions.delete(session.id);
        showOpenMessage('信息与原提交不一致，请核对后重新提交。', true);
      } else if (error instanceof InvitationError && error.status === 400) {
        showOpenMessage('请检查姓名和邮箱后重试。', true);
      } else {
        showOpenMessage('暂时无法确认预约结果，请重新核对这次提交。', true);
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新确认提交';
        retry.addEventListener('click', () => void submitOpenSession(session, draft, submissionId));
        openDialog.querySelector('[data-open-message]')?.append(retry);
      }
    } finally {
      openSubmitting = false;
      if (alive) {
        updateControls();
        if (refresh && week) void loadWeek(week.week);
      }
    }
  }

  openDialog?.addEventListener('click', event => {
    if (!openSubmitting && (event.target as Element).closest('[data-open-close]')) openDialog.close();
  });
  openDialog?.addEventListener('cancel', event => { if (openSubmitting) event.preventDefault(); });
  openDialog?.addEventListener('close', () => {
    const id = selectedOpen?.id;
    selectedOpen = undefined;
    if (calendarDownload) URL.revokeObjectURL(calendarDownload);
    calendarDownload = undefined;
    if (id) calendar?.querySelector<HTMLButtonElement>(`button[data-open-session="${CSS.escape(id)}"]:not(:disabled)`)?.focus({ preventScroll: true });
  });
  openDialog?.addEventListener('submit', event => {
    event.preventDefault();
    const form = (event.target as HTMLFormElement);
    const session = openSessions().find(item => item.id === selectedOpen?.id);
    if (!session || session.remaining === 0 || preview || openSubmitting || openReceipt || !form.reportValidity()) return;
    const fields = new FormData(form);
    const name = String(fields.get('name') ?? '').trim();
    const inputEmail = String(fields.get('email') ?? '').trim();
    const email = inputEmail ? parseEmailAddress(inputEmail) : undefined;
    if (!name || (inputEmail && !email) || (session.emailRequired && !email)) {
      showOpenMessage('请填写姓名，并检查邮箱是否完整。', true);
      return;
    }
    const draft = { name, ...(email ? { email } : {}), website: String(fields.get('website') ?? '') };
    const body = JSON.stringify(draft);
    if (openSubmissions.get(session.id)?.body !== body) openSubmissions.set(session.id, { body, id: crypto.randomUUID() });
    void submitOpenSession(session, draft, openSubmissions.get(session.id)!.id);
  });

  function drawCalendar() {
    if (!week) return;
    const instant = now();
    const today = bookingDate(instant);
    const days = week.days;
    const currentDay = days.find(day => day.date === visibleDay) ?? days.find(day => day.date === today) ?? days[0];
    visibleDay = currentDay.date;
    drawPeriod(currentDay);
    if (!calendar) return;
    const slots = new Map(days.flatMap(day => day.slots.map(slot => [slot.startAt, slot] as const)));
    const showAvailability = availabilityReady();
    const selectedEnd = selectedStart + selectedDuration * minute;
    const stateAt = (startAt: number): CalendarState => {
      const slot = slots.get(startAt);
      if (startAt <= instant || slot?.state === 'expired') return 'expired';
      if (showAvailability && slot?.availability) {
        return slot.availability === 'blocked' || (slot.availability === 'busy' && hideBusy) ? 'unavailable' : slot.availability;
      }
      return slot?.state ?? 'unavailable';
    };
    const showSelection = Boolean(selectedStart && (mode !== 'direct' || showAvailability));
    const inSelection = (startAt: number) => showSelection && startAt >= selectedStart && startAt < selectedEnd;
    const sessions = openSessions();
    const slotMarkup = (day: Day, startAt: number, row: number) => {
      const session = sessions.find(item => item.startAt < startAt + step && item.endAt > startAt);
      if (session) {
        const first = row === 0 || session.startAt >= startAt;
        const last = row === 23 || session.endAt <= startAt + step;
        const label = `${shortDate(bookingDate(session.startAt))} ${time(session.startAt)}–${time(session.endAt)} ${session.title}，${sessionCapacity(session)}`;
        return `<button type="button" class="booking-slot booking-open-slot booking-open-slot--${session.color}${session.remaining === 0 ? ' booking-open-full' : ''}${first ? '' : ' joins-before'}${last ? '' : ' joins-after'}"
          data-open-session="${e(session.id)}" title="${e(label)}" aria-label="${e(label)}"${first ? '' : ' tabindex="-1"'}${session.remaining === 0 ? ' disabled' : ''}>
          ${first ? `<span><span class="booking-open-slot-title">${e(session.emoji)} ${e(session.title)}</span><small class="booking-open-slot-time">${time(session.startAt)}–${time(session.endAt)}</small>${session.remaining === 0 ? '<span class="booking-open-slot-status">已约满</span>' : ''}</span>` : ''}
        </button>`;
      }
      const slot = slots.get(startAt);
      const state = stateAt(startAt);
      const chosen = Boolean(slot && canChoose(slot) && !submitted);
      const selected = state !== 'expired' && inSelection(startAt);
      const first = selected && startAt === selectedStart;
      const last = selected && startAt + step >= selectedEnd;
      const status = selected ? '已选择' : stateNames[state];
      const action = chosen && !selected && mode === 'request' && state !== 'request' ? '，可发邮件申请' : '';
      const label = `${shortDate(day.date)} ${time(startAt)} ${status}${action}`;
      const busy = state === 'busy' && !selected;
      const joinBefore = busy && row > 0 && !inSelection(startAt - step) && stateAt(startAt - step) === 'busy';
      const joinAfter = busy && row < 23 && !inSelection(startAt + step) && stateAt(startAt + step) === 'busy';
      const contents = first ? `<span aria-hidden="true">✓ ${time(startAt)}</span>`
        : busy && !joinBefore ? '<span aria-hidden="true">已占用</span>'
        : chosen && !busy && !selected ? `<span class="booking-slot-time" aria-hidden="true">${time(startAt)}</span>` : '';
      const classes = `booking-slot ${state}${selected ? ' selected' : ''}${first ? ' selection-first' : ''}${last ? ' selection-last' : ''}${joinBefore ? ' joins-before' : ''}${joinAfter ? ' joins-after' : ''}`;
      return chosen
        ? `<button class="${classes}" type="button" data-slot="${startAt}" title="${label}" aria-label="${label}" aria-pressed="${first}">${contents}</button>`
        : `<span class="${classes}" role="img" aria-label="${label}">${contents}</span>`;
    };
    const dayLabel = (day: Day, index: number) => `<span class="booking-date-number">${dateNumber(day.date)}</span><span class="booking-weekday">${weekdays[index]}</span>`;
    const current = (day: Day) => day.date === today ? ' aria-current="date"' : '';
    const selection = showSelection && hasForm && !submitted
      ? `<div class="booking-range-chip"><span><strong>已选择</strong> ${shortDate(selectedDate)} ${time(selectedStart)}–${time(selectedEnd)}</span><button type="button" class="text-button booking-jump" data-jump>${mode === 'direct' ? '填写预约' : '填写申请'} ↓</button></div>`
      : '';
    if (view === 'week' && compactWeek.matches) {
      const overview = days.map((day, index) => {
        const city = cityOf(day);
        const base = dayStart(day.date);
        const segments = Array.from({ length: 24 }, (_, index) => {
          const start = base + index * step;
          if (sessions.some(session => session.startAt < start + step && session.endAt > start)) return 'booking-open-track';
          return inSelection(start) ? 'selected' : stateAt(start);
        });
        const daySessions = sessions.filter(session => bookingDate(session.startAt) === day.date);
        const state = daySessions.length ? `${daySessions.length} 场开放局` : segments.includes('selected') ? '已选择' : segments.includes('available') ? '有空闲'
          : segments.includes('busy') ? '有占用' : segments.includes('request') ? '可申请'
          : segments.every(segment => segment === 'expired') ? '已过期' : '未开放';
        const title = `${weekdays[index]} ${shortDate(day.date)} ${state}${city ? ` ${city}` : ''}，查看当天`;
        return `<button type="button" data-open-day="${e(day.date)}" aria-label="${e(title)}"${current(day)}>
          <span class="booking-overview-date"><strong>${weekdays[index]}</strong>${shortDate(day.date)}${day.date === today ? ' · 今天' : ''}</span>
          <span class="booking-overview-detail">${cityLabel(day)}</span>
          <span class="booking-overview-state">${state}<span aria-hidden="true">›</span></span>
          <span class="booking-overview-track" aria-hidden="true">${segments.map(segment => `<i class="${segment}"></i>`).join('')}</span>
        </button>`;
      }).join('');
      calendar.innerHTML = `<div class="booking-week-overview" role="group" aria-label="本周各日概览">${overview}</div>${openSessionList(days)}${selection}`;
      return;
    }
    const dayView = view === 'day';
    const visibleDays = dayView ? [currentDay] : days;
    const starts = visibleDays.map(day => dayStart(day.date));
    const column = (day: Day) => !dayView && days.indexOf(day) >= 5 ? ' class="booking-weekend"' : '';
    const rows = Array.from({ length: 24 }, (_, row) => {
      const hour = row % 2 === 0;
      const clock = time(starts[0] + row * step);
      return `<tr${hour ? ' class="booking-hour"' : ''}><th scope="row"${hour ? '' : ' class="booking-half-hour"'}>${clock}</th>${visibleDays.map((day, index) => `<td${column(day)}>${slotMarkup(day, starts[index] + row * step, row)}</td>`).join('')}</tr>`;
    }).join('');
    calendar.innerHTML = `
      ${dayView ? `<div class="booking-days" role="group" aria-label="本周日期">${days.map((day, index) => `<button type="button" data-day="${e(day.date)}" aria-label="${weekdays[index]} ${shortDate(day.date)}" aria-pressed="${day === currentDay}"${current(day)}>${dayLabel(day, index)}</button>`).join('')}</div>` : ''}
      <table class="booking-time-grid ${dayView ? 'booking-day-grid' : 'booking-week-grid'}" aria-label="${dayView ? '当日' : '本周'}时间网格（UTC+8）">
        <thead>
          ${dayView ? '' : `<tr><th scope="col">时间</th>${days.map((day, index) => `<th scope="col"${column(day)}>
            <button type="button" data-open-day="${e(day.date)}" aria-label="${weekdays[index]} ${shortDate(day.date)}，查看当天"${current(day)}>${dayLabel(day, index)}</button>
          </th>`).join('')}</tr>`}
          <tr class="booking-location-row"><th scope="row">全天</th>${visibleDays.map(day => `<td${column(day)}>${cityLabel(day)}</td>`).join('')}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>${selection}`;
  }

  function syncSelection() { syncForm(); drawCalendar(); updateControls(); }

  function scheduleExpiry() {
    window.clearTimeout(expiryTimer);
    const deadlines = openSessions().map(session => session.startAt);
    if (availabilityReady() && week?.validUntil !== undefined) deadlines.push(week.validUntil);
    if (deadlines.length) expiryTimer = window.setTimeout(refreshClock, Math.max(1, Math.ceil(Math.min(...deadlines) - now())));
  }

  function setWeek(data: Week, edge?: 'first' | 'last') {
    const sameWeek = week?.weekStart === data.weekStart;
    const active = document.activeElement;
    const focused = sameWeek && calendar?.contains(active) ? active : undefined;
    const focusKey = focused?.getAttributeNames().find(name => name.startsWith('data-'));
    if (!sameWeek) {
      selectedDate = '';
      selectedStart = 0;
      visibleDay = edge ? data.days[edge === 'first' ? 0 : data.days.length - 1].date : '';
    }
    week = data;
    if (weekVerified) {
      directOffered = allowDirect && availabilityReady();
      if (!directOffered && allowRequest) mode = 'request';
    }
    readAt = performance.now();
    lastTick = Math.floor(now() / step);
    scheduleExpiry();
    syncSelection();
    if (focused && focusKey) {
      const value = CSS.escape(focused.getAttribute(focusKey)!);
      calendar?.querySelector<HTMLButtonElement>(`button[${focusKey}="${value}"]`)?.focus({ preventScroll: true });
    }
  }

  async function loadWeek(offset: number, edge?: 'first' | 'last') {
    if (!alive || submitting || openSubmitting) return;
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
  todayButton?.addEventListener('click', () => {
    if (!week || submitting) return;
    if (week.week !== 0) void loadWeek(0);
    else if (view === 'day') showDay(bookingDate(now()));
  });
  for (const button of viewButtons) button.addEventListener('click', () => {
    view = button.dataset.calendarView === 'day' ? 'day' : 'week';
    drawCalendar();
    updateControls();
  });
  for (const button of modeButtons) button.addEventListener('click', () => {
    const nextMode = button.dataset.bookingMode === 'direct' ? 'direct' : 'request';
    if (submitting || mode === nextMode || (nextMode === 'direct' && !directOffered)) return;
    mode = nextMode;
    showRequestMessage('');
    syncSelection();
  });
  calendar?.addEventListener('click', event => {
    if (submitting || openSubmitting) return;
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target) return;
    const date = target.dataset.day ?? target.dataset.openDay;
    if (target.dataset.openSession) {
      showOpenSession(target.dataset.openSession);
    } else if (date) {
      showDay(date);
      calendar.querySelector<HTMLButtonElement>(`[data-day="${visibleDay}"]`)?.focus({ preventScroll: true });
    } else if (target.dataset.slot) {
      const startAt = Number(target.dataset.slot);
      choose(startAt);
      calendar.querySelector<HTMLButtonElement>(`[data-slot="${startAt}"]`)?.focus({ preventScroll: true });
    } else if (target.hasAttribute('data-jump')) {
      actionTitle?.focus();
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

  async function submitAttempt(draft: ReturnType<typeof readDraft>, submissionId: string, bookingMode: BookingMode) {
    if (!alive || !form || !week || !weekVerified || preview || submitting || submitted) return;
    const direct = bookingMode === 'direct';
    submitting = true;
    let refreshWeek: number | undefined;
    showRequestMessage('正在提交申请…');
    updateControls();
    try {
      const response = await send(direct ? '/invite/direct' : '/invite/requests', { ...draft, submissionId });
      if (!alive) return;
      if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) throw new Error('Invalid confirmation');
      submitted = true;
      delete lastSubmissions.request;
      delete lastSubmissions.direct;
      form.reset();
      const title = direct ? '预约已确认' : '已收到申请，等待确认';
      const detail = direct
        ? 'mailStatus' in response && response.mailStatus === 'sent' ? '确认邮件已发出。' : '预约已生效，确认邮件暂未确认发出。'
        : '邀请人确认后会通过邮件回复。';
      const confirmedTime = direct && 'startAt' in response && 'endAt' in response
        && typeof response.startAt === 'number' && typeof response.endAt === 'number'
        && Number.isFinite(new Date(response.startAt + chinaOffset).getTime())
        && Number.isFinite(new Date(response.endAt + chinaOffset).getTime())
        ? `<p>${shortDate(bookingDate(response.startAt))} ${time(response.startAt)}–${time(response.endAt)}（UTC+8）</p>` : '';
      root.querySelector<HTMLElement>('[data-request-content]')!.innerHTML = `<div class="booking-receipt" role="status"><strong>${title}</strong>${confirmedTime}<p>${detail}</p></div>`;
      drawCalendar();
    } catch (error) {
      if (!alive) return;
      if (error instanceof InvitationError && (error.status === 401 || error.status === 404)) { unavailable(); return; }
      if (error instanceof InvitationError && error.status === 429) {
        showRequestMessage(direct ? '预约操作过于频繁，请稍后再试。' : '申请操作过于频繁，请稍后再试。也可复制申请文字。', true);
      } else if (error instanceof InvitationError && error.code === 'REQUESTS_DISABLED') {
        if (direct) {
          week.canBook = false;
          refreshWeek = week.week;
          showRequestMessage('暂时无法直接预约。正在重新核对空闲时段。', true);
        } else {
          week.canSubmit = false;
          showRequestMessage('在线申请暂未开启。可复制申请文字发给邀请人。', true);
        }
      } else if (error instanceof InvitationError && ['SLOT_UNAVAILABLE', 'SLOT_CONFLICT'].includes(error.code)) {
        selectedStart = 0;
        refreshWeek = week.week;
        showRequestMessage(direct ? '这个时段已无法预约，请选择其他时间。' : '这个时段已经不能申请了，请选择其他时间。', true);
      } else if (error instanceof InvitationError && error.code === 'SUBMISSION_CHANGED') {
        delete lastSubmissions[bookingMode];
        showRequestMessage('表单内容与原提交不一致，请核对后重新提交。', true);
      } else if (error instanceof InvitationError && error.status === 400) {
        syncSelection();
        showRequestMessage('请检查所选时间和表单信息后重试。', true);
      } else {
        showRequestMessage(direct ? '暂时无法确认预约结果，请重新确认这次提交。' : '暂时无法确认提交结果。可重新确认这次提交，或复制申请文字发给邀请人。', true);
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新确认提交';
        retry.addEventListener('click', () => void submitAttempt(draft, submissionId, bookingMode));
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
    if (!canSubmitCurrentMode() || preview || submitting || submitted) return;
    if (!hasValidSelection()) {
      syncSelection();
      showRequestMessage(mode === 'direct' ? '请选择仍可预约的日期、时间和时长。' : '请选择仍可申请的日期、时间和时长。', true);
      return;
    }
    const draft = readDraft();
    const email = parseEmailAddress(draft.email);
    if (!draft.name || !email) { showRequestMessage('请填写姓名和有效邮箱。', true); return; }
    draft.email = email;
    const body = JSON.stringify(draft);
    if (lastSubmissions[mode]?.body !== body) lastSubmissions[mode] = { body, id: crypto.randomUUID() };
    void submitAttempt(draft, lastSubmissions[mode]!.id, mode);
  });

  copyButton?.addEventListener('click', async () => {
    if (mode !== 'request' || submitting || submitted) return;
    if (!hasValidSelection()) { showRequestMessage('请先选择想申请的时间。', true); return; }
    const draft = readDraft();
    const text = [
      '你好，我想申请见面时间。',
      `${selectedDate} ${time(selectedStart)}–${time(selectedStart + selectedDuration * minute)}（UTC+8）`,
      `见面方式：${draft.meetingType === 'in-person' ? '线下' : '线上'}`,
      `姓名：${draft.name}`, `邮箱：${draft.email}`, ...(draft.notes ? [`备注：${draft.notes}`] : []),
    ].join('\n');
    const copied = await copyText(text);
    if (!alive || submitted || mode !== 'request') return;
    if (manualCopy) {
      manualCopy.hidden = copied;
      const field = manualCopy.querySelector('textarea')!;
      field.value = copied ? '' : text;
      if (!copied) { field.focus(); field.select(); }
    }
    showRequestMessage(copied ? '申请文字已复制，可发给邀请人。' : '请手动复制下方的申请文字。');
  });

  function refreshClock() {
    if (!alive || !week || submitting || openSubmitting || document.hidden) return;
    if (week.days.at(-1)!.date < bookingDate(now())) { void loadWeek(0); return; }
    if (!weekRequest && weekVerified && week.availability === 'ready' && week.validUntil !== undefined && now() >= week.validUntil) {
      void loadWeek(week.week);
      return;
    }
    if (week.openSessions?.some(session => session.startAt <= now())) {
      week.openSessions = week.openSessions.filter(session => session.startAt > now());
      syncSelection();
      scheduleExpiry();
    }
    const tick = Math.floor(now() / step);
    if (tick !== lastTick) { lastTick = tick; syncSelection(); }
  }
  const redrawWeek = () => { if (view === 'week') drawCalendar(); };
  if (hasCalendar) compactWeek.addEventListener('change', redrawWeek);
  const timer = window.setInterval(refreshClock, 30_000);
  document.addEventListener('visibilitychange', refreshClock);
  void loadWeek(0);
  return () => {
    alive = false;
    weekRequest?.abort();
    weekRequest = undefined;
    delete lastSubmissions.request;
    delete lastSubmissions.direct;
    openSubmissions.clear();
    if (calendarDownload) URL.revokeObjectURL(calendarDownload);
    openDialog?.close();
    openDialog?.remove();
    if (hasCalendar) compactWeek.removeEventListener('change', redrawWeek);
    window.clearTimeout(expiryTimer);
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', refreshClock);
  };
}
