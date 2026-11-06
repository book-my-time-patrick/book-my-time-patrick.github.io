import './admin.css';
import { escapeHtml as e } from './ui';

type Action = 'confirm' | 'decline' | 'suggest';
const actions: Record<Action, string> = { confirm: '确认预约', decline: '拒绝申请', suggest: '发送建议时间' };
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
});

export function renderRequestReview(root: HTMLElement, token: string, action: Action) {
  const controller = new AbortController();
  const signal = controller.signal;
  async function request(body?: Record<string, unknown>) {
    if (!__API_BASE_URL__) throw new Error('NETWORK');
    const response = await fetch(`${__API_BASE_URL__}/request-action`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? 'NOT_FOUND' : typeof data.error === 'string' ? data.error : 'NETWORK');
    return data;
  }
  function page(title: string, content: string) {
    root.innerHTML = `<main class="admin-page"><section class="admin-auth"><p class="eyebrow">APPOINTMENT REQUEST</p><h1>${e(title)}</h1><section class="admin-card">${content}</section></section></main>`;
  }
  function errorPage(error: unknown) {
    if (signal.aborted) return;
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      page('链接已失效', '<p class="admin-copy">这项申请可能已处理或已过期。你可以在后台查看状态。</p><a class="secondary" href="#/admin">打开后台</a>');
      return;
    }
    page('暂时无法连接', '<p class="admin-copy">请检查网络后重试。</p><button class="secondary" type="button" id="review-retry">重试</button>');
    root.querySelector('#review-retry')?.addEventListener('click', () => void load());
  }
  async function load() {
    page('正在读取申请', '<p class="admin-copy" role="status">请稍候…</p>');
    try {
      const data = await request() as { name: string; startAt: number; endAt: number; meetingType: string };
      if (signal.aborted) return;
      const times = `${formatter.format(data.startAt)}–${formatter.format(data.endAt)}（UTC+8）`;
      const duration = Math.round((data.endAt - data.startAt) / 60_000);
      const suggestion = action === 'suggest' ? `<div class="admin-form-row"><label class="admin-field">建议日期（UTC+8）<input type="date" name="date" required></label><label class="admin-field">建议开始时间<input type="time" name="time" min="09:00" max="20:30" step="1800" required></label></div><label class="admin-field">时长<select name="duration">${[30,60,90,120].map(value => `<option value="${value}"${value === duration ? ' selected' : ''}>${value} 分钟</option>`).join('')}</select></label>` : '';
      page(actions[action], `<p class="admin-copy"><strong>${e(data.name)}</strong><br>${e(times)}<br>${data.meetingType === 'online' ? '线上' : '线下'}</p><form id="review-form">${suggestion}<label class="admin-field">给对方的留言（选填）<textarea name="message" maxlength="500" rows="3"></textarea></label><p class="admin-banner" id="review-message" role="status" aria-live="polite"></p><button class="primary" type="submit">${actions[action]}</button></form>`);
      const form = root.querySelector<HTMLFormElement>('#review-form')!;
      const submit = form.querySelector<HTMLButtonElement>('button')!;
      const message = root.querySelector<HTMLElement>('#review-message')!;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        message.textContent = '正在处理…';
        const values = new FormData(form);
        const input: Record<string, unknown> = { action, message: String(values.get('message') ?? '') };
        if (action === 'suggest') {
          input.startAt = Date.parse(`${values.get('date')}T${values.get('time')}:00+08:00`);
          input.duration = Number(values.get('duration'));
        }
        try {
          const result = await request(input);
          if (signal.aborted) return;
          history.replaceState(null, '', '#/');
          const title = result.status === 'confirmed' ? '预约已确认' : result.status === 'declined' ? '已拒绝申请' : '已记录建议时间';
          page(title, `<p class="admin-copy">${result.mailStatus === 'sent' ? '发信服务已接受通知邮件。' : '处理结果已保存。你可以在后台查看邮件状态并重试。'}</p><a class="secondary" href="#/admin">打开后台</a>`);
        } catch (error) {
          if (signal.aborted) return;
          const code = error instanceof Error ? error.message : '';
          if (code === 'NOT_FOUND' || code === 'BOOKING_CHANGED') { errorPage(new Error('NOT_FOUND')); return; }
          message.classList.add('error');
          message.textContent = code === 'SLOT_CONFLICT' ? '该时段已有确认预约，请从后台建议其他时间。'
            : code === 'SLOT_UNAVAILABLE' || code === 'INVALID_INPUT' ? '请选择规则范围内的工作日时段。'
            : '暂时无法确认处理结果。你可以重试，或在后台查看这项申请。';
          submit.disabled = false;
        }
      });
    } catch (error) { errorPage(error); }
  }
  void load();
  return () => { controller.abort(); root.replaceChildren(); };
}
