import { escapeHtml as e } from './ui';
import { BOOKING_DAY, BOOKING_TIMEZONE, REQUEST_DURATIONS, bookingDate, isRequestSlot } from '../../shared/booking';

export type RequestFilter = 'pending' | 'confirmed' | 'history';
type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'suggested' | 'cancelled' | 'expired';
type Decision = 'confirm' | 'decline' | 'suggest' | 'cancel' | 'reschedule';
type MailStatus = 'pending' | 'sent' | 'failed' | 'unconfigured';

export interface BookingView {
  id: string;
  inviteId: string;
  name: string;
  email: string;
  startAt: number;
  endAt: number;
  meetingType: 'online' | 'in-person';
  notes: string;
  status: BookingStatus;
  createdAt: number;
  updatedAt: number;
  message: string;
  mailStatus: MailStatus;
}

interface Mailbox { id: string; address: string; verifiedAt: number | null }
export interface MailSettings {
  sender: string;
  apiKeyConfigured: boolean;
  acceptRequests: boolean;
  primaryDeliveryId: string | null;
  notificationId: string | null;
  mailboxes: Mailbox[];
  overrides: { inviteId: string; mailboxId: string }[];
}

interface MailInvite { id: string; label: string }
export interface PanelActions {
  request<T = { ok: boolean }>(path: string, body?: unknown, method?: string): Promise<T>;
  run(operation: () => Promise<void>, button?: HTMLButtonElement): Promise<void>;
  banner(message: string, error?: boolean): void;
  isCurrent(): boolean;
  reload(message?: string): Promise<void>;
}

const filterLabels: Record<RequestFilter, string> = { pending: '待确认', confirmed: '已确认', history: '历史记录' };
const bookingLabels: Record<BookingStatus, string> = {
  pending: '待确认', confirmed: '已确认', declined: '已拒绝', suggested: '已建议时间', cancelled: '已取消', expired: '已过期',
};
const mailLabels: Record<MailStatus, string> = {
  pending: '邮件待发送', sent: '发信服务已接收', failed: '邮件发送失败', unconfigured: '邮件通道未就绪',
};
const decisionLabels: Record<Decision, string> = {
  confirm: '确认预约', decline: '拒绝申请', suggest: '建议其他时间', cancel: '取消预约', reschedule: '调整预约时间',
};
const decisionResults: Record<Decision, string> = {
  confirm: '预约已确认。', decline: '申请已拒绝。', suggest: '建议时间已保存。', cancel: '预约已取消。', reschedule: '预约时间已更新。',
};
const dateAndTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BOOKING_TIMEZONE, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const timeOnly = new Intl.DateTimeFormat('zh-CN', { timeZone: BOOKING_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function textValue(form: FormData, name: string) { return String(form.get(name) ?? '').trim(); }

function onSubmit(form: HTMLFormElement, actions: PanelActions, handler: (data: FormData) => Promise<void>) {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!actions.isCurrent()) return;
    const data = new FormData(form);
    void actions.run(() => handler(data), button);
  });
}

export function renderBookingInbox(
  content: HTMLElement, requests: BookingView[], filter: RequestFilter, actions: PanelActions,
  chooseFilter: (filter: RequestFilter) => void,
) {
  content.innerHTML = `
    <section class="admin-card admin-m2-inbox">
      <div class="admin-section-head">
        <h2>预约申请</h2>
        <button class="text-button" type="button" data-refresh>刷新</button>
      </div>
      <nav class="admin-actions admin-m2-filters" aria-label="按预约状态查看">
        ${Object.entries(filterLabels).map(([key, label]) => `<button class="secondary" type="button" data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`).join('')}
      </nav>
      <p class="admin-copy">时间统一显示为北京时间（UTC+8）。确认前请核对你的日历，待确认申请不占用时段。</p>
      <div class="admin-list" data-bookings></div>
    </section>`;
  content.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => {
    button.addEventListener('click', () => {
      const next = button.dataset.filter as RequestFilter;
      if (next !== filter && actions.isCurrent()) chooseFilter(next);
    });
  });
  const refresh = content.querySelector<HTMLButtonElement>('[data-refresh]')!;
  refresh.addEventListener('click', () => void actions.run(() => actions.reload(), refresh));
  const list = content.querySelector<HTMLElement>('[data-bookings]')!;
  if (!requests.length) {
    list.innerHTML = `<p class="admin-empty">${filter === 'history' ? '暂无历史记录。' : `暂无${filterLabels[filter]}的预约。`}</p>`;
    return;
  }
  for (const request of requests) {
    const canDecide = request.status === 'pending' || request.status === 'suggested';
    const canChange = request.status === 'confirmed' && request.startAt > Date.now();
    const decisions: Decision[] = canDecide ? ['confirm', 'suggest', 'decline'] : canChange ? ['reschedule', 'cancel'] : [];
    const item = document.createElement('article');
    item.className = 'admin-item';
    item.innerHTML = `
      <div class="admin-item-head">
        <h3>${e(request.name)}</h3>
        <span class="admin-pill${request.status === 'confirmed' || canDecide ? '' : ' muted'}">${e(bookingLabels[request.status])}</span>
      </div>
      <p class="admin-m2-time">${e(dateAndTime.format(request.startAt))}–${e(timeOnly.format(request.endAt))}</p>
      <p class="admin-item-description">${e(request.email)} · ${request.meetingType === 'online' ? '线上' : '线下'}</p>
      ${request.notes ? `<p class="admin-item-description admin-m2-notes">访客备注 · ${e(request.notes)}</p>` : ''}
      ${request.message ? `<p class="admin-item-description admin-m2-notes">处理留言 · ${e(request.message)}</p>` : ''}
      <div class="admin-item-meta">
        <span>提交于 ${e(dateAndTime.format(request.createdAt))}</span>
        <span>${e(mailLabels[request.mailStatus])}</span>
      </div>
      <div class="admin-actions">
        ${decisions.map(decision => `<button type="button" class="${decision === 'cancel' || decision === 'decline' ? 'text-button admin-danger' : 'secondary'}" data-decision="${decision}">${decisionLabels[decision]}</button>`).join('')}
        ${request.mailStatus !== 'sent' && request.status !== 'expired' ? '<button class="text-button" type="button" data-notify>重试发信</button>' : ''}
      </div>
      <div data-decision-editor></div>`;
    item.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach(button => {
      button.addEventListener('click', () => {
        const editor = item.querySelector<HTMLElement>('[data-decision-editor]')!;
        showDecisionForm(editor, request, button.dataset.decision as Decision, actions);
      });
    });
    const notify = item.querySelector<HTMLButtonElement>('[data-notify]');
    notify?.addEventListener('click', () => void actions.run(async () => {
      const data = await actions.request<{ request: BookingView }>(`/admin/requests/${encodeURIComponent(request.id)}/notify`, {});
      if (actions.isCurrent()) await actions.reload(mailLabels[data.request.mailStatus]);
    }, notify));
    list.append(item);
  }
}

function showDecisionForm(editor: HTMLElement, booking: BookingView, decision: Decision, actions: PanelActions) {
  const changeTime = decision === 'reschedule' || decision === 'suggest';
  const timeOptions = Array.from({ length: 24 }, (_, index) => `${String(9 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);
  const currentTime = timeOnly.format(booking.startAt);
  const minutes = (booking.endAt - booking.startAt) / 60_000;
  editor.innerHTML = `
    <form class="admin-m2-editor" method="post" aria-label="${decisionLabels[decision]}">
      <h4>${decisionLabels[decision]}</h4>
      ${changeTime ? `<p class="admin-help">北京时间（UTC+8） · 工作日 09:00–21:00</p>
        <div class="admin-form-row">
          <label class="admin-field">日期<input type="date" name="date" min="${bookingDate(Date.now())}" max="${bookingDate(Date.now() + 30 * BOOKING_DAY)}" value="${bookingDate(booking.startAt)}" required></label>
          <label class="admin-field">开始时间<select name="time" required>${timeOptions.map(time => `<option value="${time}"${time === currentTime ? ' selected' : ''}>${time}</option>`).join('')}</select></label>
        </div>
        <label class="admin-field">时长<select name="duration">${REQUEST_DURATIONS.map(duration => `<option value="${duration}"${duration === minutes ? ' selected' : ''}>${duration} 分钟</option>`).join('')}</select></label>` : ''}
      <label class="admin-field">给对方的留言（可选）<textarea name="message" rows="2" maxlength="1000"></textarea></label>
      <div class="admin-actions">
        <button class="primary" type="submit">${decisionLabels[decision]}</button>
        <button class="text-button" type="button" data-close-editor>返回</button>
      </div>
    </form>`;
  editor.querySelector('[data-close-editor]')!.addEventListener('click', () => editor.replaceChildren());
  const form = editor.querySelector<HTMLFormElement>('form')!;
  onSubmit(form, actions, async data => {
    const input: { action: Decision; expectedUpdatedAt: number; message: string; startAt?: number; duration?: number } = {
      action: decision, expectedUpdatedAt: booking.updatedAt, message: textValue(data, 'message'),
    };
    if (changeTime) {
      const localDate = textValue(data, 'date');
      const localTime = textValue(data, 'time');
      const startAt = Date.parse(`${localDate}T${localTime}:00+08:00`);
      const duration = Number(textValue(data, 'duration'));
      if (!isRequestSlot(startAt, duration, Date.now())) {
        actions.banner('请选择未来 30 天内的工作日，整段时间须在北京时间 09:00–21:00。', true);
        return;
      }
      input.startAt = startAt;
      input.duration = duration;
    }
    if (decision === 'cancel' && !confirm('取消后将释放该预约时段，并通知受邀者。确定取消预约吗？')) return;
    if (decision === 'decline' && !confirm('确定拒绝这条申请并通知受邀者吗？')) return;
    const dataAfterDecision = await actions.request<{ request: BookingView }>(`/admin/requests/${encodeURIComponent(booking.id)}/decision`, input);
    if (actions.isCurrent()) await actions.reload(`${decisionResults[decision]}${mailLabels[dataAfterDecision.request.mailStatus]}。`);
  });
  form.querySelector<HTMLElement>('input, textarea')?.focus();
}

function mailboxOptions(mailboxes: Mailbox[], selected: string | null, emptyLabel: string) {
  return `<option value="">${emptyLabel}</option>${mailboxes.map(mailbox => `<option value="${e(mailbox.id)}"${selected === mailbox.id ? ' selected' : ''}>${e(mailbox.address)}</option>`).join('')}`;
}

export function renderMailSettings(content: HTMLElement, settings: MailSettings, invites: MailInvite[], actions: PanelActions) {
  const verified = settings.mailboxes.filter(mailbox => mailbox.verifiedAt !== null);
  const senderReady = Boolean(settings.sender && settings.apiKeyConfigured);
  content.innerHTML = `
    <section class="admin-card admin-m2-settings">
      <div class="admin-section-head"><h2>发信服务</h2><span class="admin-pill${senderReady ? '' : ' muted'}">${senderReady ? '已保存配置' : '待配置'}</span></div>
      <p class="admin-copy">使用 Resend 的免费发信额度。先在 Resend 添加并验证发信子域名，再创建仅有发信权限的 API 密钥。<a class="admin-m2-link" href="https://resend.com/docs/dashboard/domains/introduction" target="_blank" rel="noopener noreferrer">查看域名验证指南 ↗</a></p>
      <form method="post" data-mail-sender>
        <label class="admin-field">发件地址<input name="sender" type="email" maxlength="254" autocomplete="off" spellcheck="false" value="${e(settings.sender)}" placeholder="booking@notify.book-my-time-patrick.cn" required></label>
        <label class="admin-field">Resend API 密钥<input name="apiKey" type="password" maxlength="193" autocomplete="off" spellcheck="false" placeholder="${settings.apiKeyConfigured ? '填写新密钥以替换' : '粘贴发信密钥'}" ${settings.apiKeyConfigured ? '' : 'required'}><span class="admin-help">提交后会清空输入框。${settings.apiKeyConfigured ? '留空可继续使用现有密钥。' : ''}</span></label>
        <div class="admin-actions"><button class="primary" type="submit">保存发信配置</button></div>
      </form>
    </section>
    <section class="admin-card admin-m2-settings">
      <div class="admin-section-head"><h2>收件邮箱</h2><span class="admin-count">${settings.mailboxes.length} 个</span></div>
      <p class="admin-copy">添加后发一封验证码邮件验证地址，再用测试 .ics 检查能否收件和打开附件。换地址时请先添加并验证新邮箱。</p>
      <form class="admin-m2-add-mailbox" method="post" data-add-mailbox>
        <label class="admin-field">邮箱地址<input name="address" type="email" maxlength="254" autocomplete="off" spellcheck="false" placeholder="name@example.com" required></label>
        <button class="secondary" type="submit">添加邮箱</button>
      </form>
      <div class="admin-list" data-mailbox-list></div>
    </section>
    <section class="admin-card admin-m2-settings">
      <div class="admin-section-head"><h2>通知与日历送达</h2><span class="admin-pill${settings.acceptRequests ? '' : ' muted'}">${settings.acceptRequests ? '正在接收申请' : '暂未开放申请'}</span></div>
      <p class="admin-copy">预约日历附件送到主送达邮箱。申请通知可指定另一个地址，也可以与主送达邮箱相同。</p>
      <form method="post" data-mail-routing>
        <div class="admin-form-row">
          <label class="admin-field">主送达邮箱<select name="primaryDeliveryId">${mailboxOptions(verified, settings.primaryDeliveryId, '请选择已验证的邮箱')}</select></label>
          <label class="admin-field">通知邮箱<select name="notificationId">${mailboxOptions(verified, settings.notificationId, '与主送达邮箱相同')}</select></label>
        </div>
        <label class="admin-checkbox admin-m2-enable"><input type="checkbox" name="acceptRequests"${settings.acceptRequests ? ' checked' : ''}>接收邀请链接提交的预约申请</label>
        <p class="admin-help" data-request-readiness></p>
        <div class="admin-actions"><button class="primary" type="submit">保存送达设置</button></div>
      </form>
    </section>
    <section class="admin-card admin-m2-settings">
      <div class="admin-section-head"><h2>邀请专用送达邮箱</h2></div>
      <p class="admin-copy">为某条邀请指定不同的日历送达邮箱。其余链接沿用主送达邮箱。</p>
      ${invites.length && verified.length ? `<form method="post" data-mail-override>
        <div class="admin-form-row">
          <label class="admin-field">邀请链接<select name="inviteId" required>${invites.map(invite => `<option value="${e(invite.id)}">${e(invite.label)}</option>`).join('')}</select></label>
          <label class="admin-field">送达邮箱<select name="mailboxId">${mailboxOptions(verified, null, '使用主送达邮箱')}</select></label>
        </div>
        <div class="admin-actions"><button class="primary" type="submit">保存此链接的送达邮箱</button></div>
      </form>` : '<p class="admin-empty">添加有效邀请并验证收件邮箱后，可在这里指定送达地址。</p>'}
    </section>`;

  const sender = content.querySelector<HTMLFormElement>('[data-mail-sender]')!;
  onSubmit(sender, actions, async data => {
    const apiKey = textValue(data, 'apiKey');
    const input = sender.querySelector<HTMLInputElement>('[name="apiKey"]')!;
    input.value = '';
    data.delete('apiKey');
    await actions.request('/admin/mail', { sender: textValue(data, 'sender'), ...(apiKey ? { apiKey } : {}) }, 'PATCH');
    if (actions.isCurrent()) await actions.reload('发信配置已保存。接下来请验证收件邮箱。');
  });

  const addMailbox = content.querySelector<HTMLFormElement>('[data-add-mailbox]')!;
  onSubmit(addMailbox, actions, async data => {
    await actions.request('/admin/mailboxes', { address: textValue(data, 'address') });
    if (actions.isCurrent()) await actions.reload('邮箱已添加。请发送验证码并验证。');
  });

  const mailboxList = content.querySelector<HTMLElement>('[data-mailbox-list]')!;
  if (!settings.mailboxes.length) mailboxList.innerHTML = '<p class="admin-empty">尚未添加收件邮箱。</p>';
  for (const mailbox of settings.mailboxes) {
    const item = document.createElement('article');
    item.className = 'admin-item';
    const isVerified = mailbox.verifiedAt !== null;
    const path = `/admin/mailboxes/${encodeURIComponent(mailbox.id)}`;
    item.innerHTML = `
      <div class="admin-item-head"><h3>${e(mailbox.address)}</h3><span class="admin-pill${isVerified ? '' : ' muted'}">${isVerified ? '已验证' : '待验证'}</span></div>
      ${isVerified ? '' : `<form method="post" data-verify-mailbox>
        <label class="admin-field">邮箱验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="六位数字" required></label>
        <div class="admin-actions">
          <button class="secondary" type="submit">验证邮箱</button>
          <button class="text-button" type="button" data-send-code ${senderReady ? '' : 'disabled'}>发送验证码</button>
        </div>
      </form>`}
      <div class="admin-actions">
        ${isVerified ? `<button class="secondary" type="button" data-test-mailbox ${senderReady ? '' : 'disabled'}>发送测试 .ics</button>` : ''}
        <button class="text-button admin-danger" type="button" data-remove-mailbox>移除邮箱</button>
      </div>`;
    const verify = item.querySelector<HTMLFormElement>('[data-verify-mailbox]');
    if (verify) onSubmit(verify, actions, async data => {
      await actions.request(`${path}/verify`, { code: textValue(data, 'code') });
      if (actions.isCurrent()) await actions.reload('邮箱验证成功，可以设置为送达或通知邮箱。');
    });
    const code = item.querySelector<HTMLButtonElement>('[data-send-code]');
    code?.addEventListener('click', () => void actions.run(async () => {
      await actions.request(`${path}/code`, {});
      if (actions.isCurrent()) actions.banner('验证码已交给发信服务，请查收。');
    }, code));
    const test = item.querySelector<HTMLButtonElement>('[data-test-mailbox]');
    test?.addEventListener('click', () => void actions.run(async () => {
      await actions.request(`${path}/test`, {});
      if (actions.isCurrent()) actions.banner('测试 .ics 已交给发信服务，请在收件箱中查看附件。');
    }, test));
    const remove = item.querySelector<HTMLButtonElement>('[data-remove-mailbox]')!;
    remove.addEventListener('click', () => {
      if (!confirm(`确定移除 ${mailbox.address} 吗？`)) return;
      void actions.run(async () => {
        await actions.request(path, {}, 'DELETE');
        if (actions.isCurrent()) await actions.reload('邮箱已移除。');
      }, remove);
    });
    mailboxList.append(item);
  }

  const routing = content.querySelector<HTMLFormElement>('[data-mail-routing]')!;
  const primary = routing.querySelector<HTMLSelectElement>('[name="primaryDeliveryId"]')!;
  const enable = routing.querySelector<HTMLInputElement>('[name="acceptRequests"]')!;
  const readiness = routing.querySelector<HTMLElement>('[data-request-readiness]')!;
  function updateReadiness() {
    const ready = senderReady && Boolean(primary.value);
    enable.disabled = !ready;
    if (!ready) enable.checked = false;
    readiness.textContent = ready ? '保存后，允许「申请时间」的有效邀请即可提交申请。' : '开放申请前，请保存发信配置并选择一个已验证的主送达邮箱。';
  }
  primary.addEventListener('change', updateReadiness);
  updateReadiness();
  onSubmit(routing, actions, async data => {
    await actions.request('/admin/mail', {
      primaryDeliveryId: textValue(data, 'primaryDeliveryId') || null,
      notificationId: textValue(data, 'notificationId') || null,
      acceptRequests: data.has('acceptRequests'),
    }, 'PATCH');
    if (actions.isCurrent()) await actions.reload('送达设置已保存。');
  });

  const override = content.querySelector<HTMLFormElement>('[data-mail-override]');
  if (override) {
    const invitation = override.querySelector<HTMLSelectElement>('[name="inviteId"]')!;
    const mailbox = override.querySelector<HTMLSelectElement>('[name="mailboxId"]')!;
    const showOverride = () => { mailbox.value = settings.overrides.find(item => item.inviteId === invitation.value)?.mailboxId ?? ''; };
    invitation.addEventListener('change', showOverride);
    showOverride();
    onSubmit(override, actions, async data => {
      const inviteId = textValue(data, 'inviteId');
      await actions.request(`/admin/mail/overrides/${encodeURIComponent(inviteId)}`, { mailboxId: textValue(data, 'mailboxId') || null }, 'PATCH');
      if (actions.isCurrent()) await actions.reload('此邀请的送达邮箱已保存。');
    });
  }
}
