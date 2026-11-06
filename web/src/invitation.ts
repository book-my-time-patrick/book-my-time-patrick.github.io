import './admin.css';
import { InvitationError, renderInvitationBooking } from './invitation-booking';
import { escapeHtml as e, formatTime, moduleNames } from './ui';

interface Invitation {
  preview: boolean;
  expiresAt: string | number;
  permissions: { modules: string[]; modes: string[] };
  profile: { displayName: string };
}

export function renderInvitation(root: HTMLElement, token: string): () => void {
  const controller = new AbortController();
  let alive = true;
  let localToken = token;
  let disposeBooking: (() => void) | undefined;
  async function send(path: string, body?: object): Promise<unknown> {
    if (!__API_BASE_URL__) throw new Error('API unavailable');
    const request = new AbortController();
    const abort = () => request.abort();
    if (controller.signal.aborted) abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = window.setTimeout(abort, 20_000);
    try {
      const response = await fetch(`${__API_BASE_URL__}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${localToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: request.signal,
      });
      const data: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        throw new InvitationError(response.status, typeof code === 'string' ? code : '');
      }
      return data;
    } finally {
      window.clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
    }
  }
  function unavailable() {
    if (!alive) return;
    disposeBooking?.();
    root.innerHTML = '<main class="gate"><p class="eyebrow">BY INVITATION</p><h1>链接暂时无法使用</h1><p class="gate-copy">请向邀请人获取可用的邀请链接。</p><span class="gate-rule" aria-hidden="true"></span><p class="gate-note">PRIVATE APPOINTMENTS</p></main>';
  }
  async function load() {
    root.innerHTML = '<main class="gate"><p class="eyebrow">BY INVITATION</p><p class="gate-copy" role="status">正在确认你的邀请…</p></main>';
    if (!/^[A-Za-z0-9_-]{22,256}$/.test(localToken)) { unavailable(); return; }
    try {
      if (!__API_BASE_URL__) { connectionError('预约服务尚未连接，请稍后再试。'); return; }
      const invitation = await send('/invite') as Invitation;
      if (!alive) return;
      if (!invitation || !Array.isArray(invitation.permissions?.modules) || !Array.isArray(invitation.permissions.modes) || !invitation.profile || typeof invitation.preview !== 'boolean') throw new Error('Invalid response');
      const showCalendar = invitation.permissions.modules.includes('calendar');
      const allowRequest = invitation.permissions.modes.includes('request');
      const showBooking = showCalendar || allowRequest;
      const modules = invitation.permissions.modules.filter(name => name !== 'calendar' && Object.hasOwn(moduleNames, name));
      const displayName = invitation.profile.displayName ? `${e(invitation.profile.displayName)} 的预约空间。` : '';
      const intro = allowRequest ? '选一个合适的时间，留下信息，等待邀请人确认。' : showCalendar ? '查看本次邀请提供的预约时段。' : '请查看本次邀请提供的内容。';
      root.innerHTML = `<main class="invitation-page">
        <header class="invitation-header"><span class="wordmark">受邀预约 <span aria-hidden="true">↗</span></span><span>专属邀请</span></header>
        ${invitation.preview ? '<aside class="invitation-preview" role="status">受邀者预览 · 临时有效一小时<br>当前预览不计入访问记录，不会创建预约或发送邮件。</aside>' : ''}
        <section class="invitation-hero"><p class="eyebrow">YOUR INVITATION</p><h1>你的专属邀请。</h1><p>${displayName}${intro}</p><p class="admin-help">本次邀请有效至 ${e(formatTime(invitation.expiresAt))} · 当前设备时区</p></section>
        ${showBooking ? '<div id="invitation-booking"></div>' : ''}
        ${modules.length ? `<div class="invitation-grid">${modules.map(name => `<section class="invitation-card"><h2>${e(moduleNames[name])}</h2><p>该内容正在准备中。</p></section>`).join('')}</div>` : ''}
        <footer class="admin-footer">专属邀请仅供受邀者使用，请勿公开转发。</footer>
      </main>`;
      if (showBooking) {
        disposeBooking = renderInvitationBooking(root.querySelector<HTMLElement>('#invitation-booking')!, {
          showCalendar, allowRequest, preview: invitation.preview, send, unavailable,
        });
      }
    } catch (error) {
      if (!alive) return;
      if (error instanceof InvitationError && [401, 403, 404].includes(error.status)) { unavailable(); return; }
      connectionError('请检查网络后重试。这不会影响你的邀请有效期。');
    }
  }
  function connectionError(message: string) {
    if (!alive) return;
    root.innerHTML = `<main class="gate"><p class="eyebrow">BY INVITATION</p><h1>暂时无法连接。</h1><p class="gate-copy">${e(message)}</p><div class="admin-actions invitation-retry"><button class="secondary" id="retry-invitation" type="button">重新连接</button></div></main>`;
    root.querySelector('#retry-invitation')!.addEventListener('click', () => void load());
  }
  void load();
  return () => { alive = false; localToken = ''; controller.abort(); disposeBooking?.(); root.replaceChildren(); };
}
