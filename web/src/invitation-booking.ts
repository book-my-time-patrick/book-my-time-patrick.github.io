import './invitation-booking.css';
import { bookingDate, isRequestSlot, parseEmailAddress, REQUEST_DURATIONS } from '../../shared/booking';
import type { SlotState } from '../../shared/booking';
import { copyText, escapeHtml as e } from './ui';

interface Slot { startAt: number; state: SlotState }
interface Day { date: string; slots: Slot[] }
interface Week {
  now: number; week: number; maxWeek: number; weekStart: string; canSubmit: boolean;
  days: Day[]; durations: number[];
}
interface Options {
  showCalendar: boolean; allowRequest: boolean; preview: boolean;
  send: (path: string, body?: object) => Promise<unknown>;
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
const dayStart = (date: string) => Date.parse(`${date}T09:00:00+08:00`);

function readWeek(value: unknown): Week {
  const data = value as Week | undefined;
  if (!data || !Number.isSafeInteger(data.now) || !Number.isInteger(data.week) || !Number.isInteger(data.maxWeek)
    || data.week < 0 || data.week > data.maxWeek || data.maxWeek > 6 || typeof data.canSubmit !== 'boolean'
    || !Array.isArray(data.days) || data.days.length !== 7 || !Array.isArray(data.durations)
    || !data.durations.length || data.durations.some(duration => !REQUEST_DURATIONS.some(length => length === duration))) {
    throw new Error('Invalid calendar');
  }
  if (data.weekStart !== data.days[0].date) throw new Error('Invalid week start');
  for (const day of data.days) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(dayStart(day.date))
      || !Array.isArray(day.slots) || day.slots.length > 24
      || day.slots.some(slot => !slot || !Number.isSafeInteger(slot.startAt) || !Object.hasOwn(stateNames, slot.state)
        || slot.startAt < dayStart(day.date) || slot.startAt >= dayStart(day.date) + 24 * step
        || slot.startAt % step !== 0)) throw new Error('Invalid calendar day');
  }
  return data;
}

export function renderInvitationBooking(root: HTMLElement, options: Options): () => void {
  const { showCalendar, allowRequest, preview, send, unavailable } = options;
  const navigation = `<div class="booking-week-nav" aria-label="切换周">
    <button class="secondary" type="button" data-week-step="-1" aria-label="上一周" disabled>←</button>
    <p class="booking-week-range" data-week-range aria-live="polite">本周</p>
    <button class="secondary" type="button" data-week-step="1" aria-label="下一周" disabled>→</button>
  </div>`;
  const weekFeedback = '<p class="booking-feedback" data-calendar-message role="status" aria-live="polite"></p>';
  root.innerHTML = `
    ${showCalendar ? `<section class="invitation-card booking-card" aria-labelledby="booking-calendar-title">
      <div class="booking-section-head"><div><p class="eyebrow">WEEKLY CALENDAR</p><h2 id="booking-calendar-title">预约周历</h2></div><span class="booking-zone">中国标准时间 · UTC+8</span></div>
      ${navigation}
      ${weekFeedback}
      <div class="booking-legend" aria-label="周历图例">
        <span><i class="booking-key request" aria-hidden="true"></i>可申请</span>
        ${allowRequest ? '<span><i class="booking-key selected" aria-hidden="true">✓</i>已选择</span>' : ''}
        <span><i class="booking-key expired" aria-hidden="true"></i>已过期</span>
        <span><i class="booking-key unavailable" aria-hidden="true">–</i>未开放</span>
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
  const previous = root.querySelector<HTMLButtonElement>('[data-week-step="-1"]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-week-step="1"]')!;
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
  let loading = false;
  let submitting = false;
  let submitted = false;
  let mobileDate = '';
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
    previous.disabled = loading || submitting || !week || week.week === 0;
    next.disabled = loading || submitting || !week || week.week === week.maxWeek;
    calendar?.setAttribute('aria-busy', String(loading));
    if (fieldset) fieldset.disabled = submitting;
    if (submitButton) {
      submitButton.disabled = loading || submitting || !week?.canSubmit || preview || submitted;
      submitButton.textContent = submitting ? '正在提交…' : '提交申请';
    }
    if (requestState) requestState.textContent = preview ? '当前为预览，无法提交申请。' : week && !week.canSubmit ? '邀请人暂未开启在线申请。可复制申请文字发给对方。' : '申请不占位，请等待邀请人确认。';
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

  function drawCalendar() {
    if (!calendar || !week) return;
    const today = bookingDate(now());
    const currentDay = week.days.find(day => day.date === mobileDate) ?? week.days.find(day => day.date === today) ?? week.days[0];
    mobileDate = currentDay.date;
    const slotMarkup = (day: Day, startAt: number, mobile = false) => {
      const slot = day.slots.find(candidate => candidate.startAt === startAt);
      const state = startAt <= now() ? 'expired' : slot?.state ?? 'unavailable';
      const selected = state === 'request' && startAt >= selectedStart && startAt < selectedStart + selectedDuration * minute;
      const label = `${shortDate(day.date)} ${time(startAt)} ${selected ? '已选择' : stateNames[state]}`;
      const contents = `${mobile || state === 'request' ? time(startAt) : '–'}${selected && selectedStart === startAt ? ' <span aria-hidden="true">✓</span>' : ''}`;
      const classes = `booking-slot ${state}${selected ? ' selected' : ''}`;
      return state === 'request' && allowRequest && !submitted
        ? `<button class="${classes}" type="button" data-slot="${startAt}" aria-label="${label}" aria-pressed="${startAt === selectedStart}">${contents}</button>`
        : `<span class="${classes}" aria-label="${label}">${contents}</span>`;
    };
    const dayLabel = (day: Day, index: number) => `${weekdays[index]}<span>${shortDate(day.date)}</span>${day.date === today ? '<small>今天</small>' : ''}`;
    const rows = Array.from({ length: 24 }, (_, row) => {
      const hour = 9 + Math.floor(row / 2);
      const clock = `${String(hour).padStart(2, '0')}:${row % 2 ? '30' : '00'}`;
      return `<tr${row % 2 ? '' : ' class="booking-hour"'}><th scope="row">${clock}</th>${week!.days.map(day => `<td>${slotMarkup(day, dayStart(day.date) + row * step)}</td>`).join('')}</tr>`;
    }).join('');
    calendar.innerHTML = `
      <table class="booking-week-grid" aria-label="工作日九点至二十一点的申请时段">
        <thead><tr><th scope="col">时间</th>${week.days.map((day, index) => `<th scope="col"${day.date === today ? ' class="today"' : ''}>${dayLabel(day, index)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="booking-day-view">
        <div class="booking-days" aria-label="选择日期">${week.days.map((day, index) => `<button type="button" data-day="${e(day.date)}" aria-pressed="${day === currentDay}"${day.date === today ? ' aria-current="date"' : ''}>${weekdays[index]}<span>${day.date.slice(5).replace('-', '/')}</span></button>`).join('')}</div>
        <p class="booking-day-title">${shortDate(currentDay.date)} ${weekdays[week.days.indexOf(currentDay)]}${currentDay.date === today ? ' · 今天' : ''}</p>
        <div class="booking-day-slots">${Array.from({ length: 24 }, (_, row) => slotMarkup(currentDay, dayStart(currentDay.date) + row * step, true)).join('')}</div>
        ${selectedStart && allowRequest && !submitted ? `<button type="button" class="text-button booking-jump" data-jump>已选择 ${time(selectedStart)} · 填写申请 ↓</button>` : ''}
      </div>`;
  }

  function syncSelection() { syncForm(); drawCalendar(); updateControls(); }

  async function loadWeek(offset: number) {
    if (!alive || loading || submitting) return;
    loading = true;
    feedback.textContent = '正在读取周历…';
    updateControls();
    try {
      const data = readWeek(await send(`/invite/calendar?week=${offset}`));
      if (!alive) return;
      if (week && week.weekStart !== data.weekStart) { selectedDate = ''; selectedStart = 0; mobileDate = ''; }
      week = data;
      readAt = performance.now();
      lastTick = Math.floor(now() / step);
      const first = data.days[0].date;
      const last = data.days.at(-1)!.date;
      range.textContent = `${first.slice(0, 4)}年 ${shortDate(first)} – ${first.slice(0, 4) === last.slice(0, 4) ? '' : `${last.slice(0, 4)}年 `}${shortDate(last)}`;
      feedback.textContent = '';
      syncSelection();
    } catch (error) {
      if (!alive) return;
      if (error instanceof InvitationError && [401, 403, 404].includes(error.status)) { unavailable(); return; }
      feedback.textContent = '暂时无法读取周历。';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重试';
      retry.addEventListener('click', () => void loadWeek(offset));
      feedback.append(retry);
    } finally {
      loading = false;
      if (alive) updateControls();
    }
  }

  function choose(startAt: number) {
    const date = bookingDate(startAt);
    if (!availableSlots(week?.days.find(day => day.date === date)).some(slot => slot.startAt === startAt)) return;
    selectedDate = date; mobileDate = date; selectedStart = startAt;
    showRequestMessage('');
    syncSelection();
  }

  previous.addEventListener('click', () => { if (week && week.week > 0) void loadWeek(week.week - 1); });
  next.addEventListener('click', () => { if (week && week.week < week.maxWeek) void loadWeek(week.week + 1); });
  calendar?.addEventListener('click', event => {
    if (loading || submitting) return;
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target) return;
    if (target.dataset.day) {
      mobileDate = target.dataset.day;
      if (selectedDate !== mobileDate && !submitted) { selectedDate = mobileDate; selectedStart = 0; }
      syncSelection();
      calendar.querySelector<HTMLButtonElement>(`[data-day="${mobileDate}"]`)?.focus({ preventScroll: true });
    } else if (target.dataset.slot) {
      const mobile = !!target.closest('.booking-day-view');
      const startAt = Number(target.dataset.slot);
      choose(startAt);
      const view = mobile ? '.booking-day-view' : '.booking-week-grid';
      calendar.querySelector<HTMLButtonElement>(`${view} [data-slot="${startAt}"]`)?.focus({ preventScroll: true });
    } else if (target.hasAttribute('data-jump')) {
      root.querySelector<HTMLElement>('#booking-request-title')?.focus();
    }
  });

  dateField?.addEventListener('change', () => {
    selectedDate = dateField.value; mobileDate = selectedDate || mobileDate; selectedStart = 0;
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
    if (!alive || !form || !week || loading || submitting || submitted) return;
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
    if (!allowRequest || preview || !week?.canSubmit || loading || submitting || submitted) return;
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
    if (!alive || !week || loading || submitting || document.hidden) return;
    if (week.days.at(-1)!.date < bookingDate(now())) { void loadWeek(0); return; }
    const tick = Math.floor(now() / step);
    if (tick !== lastTick) { lastTick = tick; syncSelection(); }
  }
  const timer = window.setInterval(refreshClock, 30_000);
  document.addEventListener('visibilitychange', refreshClock);
  void loadWeek(0);
  return () => {
    alive = false;
    lastSubmission = undefined;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', refreshClock);
  };
}
