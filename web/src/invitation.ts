import './admin.css';
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
  function unavailable() {
    if (!alive) return;
    root.innerHTML = '<main class="gate"><p class="eyebrow">BY INVITATION</p><h1>链接暂时无法使用</h1><p class="gate-copy">请向邀请人获取可用的邀请链接。</p><span class="gate-rule" aria-hidden="true"></span><p class="gate-note">PRIVATE APPOINTMENTS</p></main>';
  }
  async function load() {
    root.innerHTML = '<main class="gate"><p class="eyebrow">BY INVITATION</p><p class="gate-copy" role="status">正在确认你的邀请…</p></main>';
    if (!/^[A-Za-z0-9_-]{22,256}$/.test(localToken)) { unavailable(); return; }
    try {
      if (!__API_BASE_URL__) { connectionError('预约服务尚未连接，请稍后再试。'); return; }
      const response = await fetch(`${__API_BASE_URL__}/invite`, { headers: { Authorization: `Bearer ${localToken}` }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!alive) return;
      if (!response.ok) {
        if (response.status === 404 || response.status === 401 || response.status === 403) { unavailable(); return; }
        throw new Error('Service unavailable');
      }
      const invitation = await response.json() as Invitation;
      if (!alive) return;
      if (!invitation || !Array.isArray(invitation.permissions?.modules) || !invitation.profile || typeof invitation.preview !== 'boolean') throw new Error('Invalid response');
      const modules = invitation.permissions.modules.filter(name => Object.hasOwn(moduleNames, name));
      root.innerHTML = `<main class="invitation-page"><header class="invitation-header"><span class="wordmark">受邀预约 <span aria-hidden="true">↗</span></span><span>专属邀请</span></header>${invitation.preview ? '<aside class="invitation-preview" role="status">受邀者预览 · 临时有效一小时<br>当前预览不计入访问记录，不会创建预约或发送邮件。</aside>' : ''}<section class="invitation-hero"><p class="eyebrow">YOUR INVITATION</p><h1>你的邀请已就绪。</h1><p>${invitation.profile.displayName ? `${e(invitation.profile.displayName)} 的预约空间正在准备中。` : '预约空间正在准备中。'}预约日历与个人展示将陆续开放，当前尚不能提交预约。</p><p class="admin-help">本次邀请有效至 ${e(formatTime(invitation.expiresAt))} · 当前设备时区</p></section><div class="invitation-grid">${modules.map(name => `<section class="invitation-card"><h2>${e(moduleNames[name])}</h2><p>此邀请已允许访问该内容。功能开放后将在这里展示。</p></section>`).join('')}</div><footer class="admin-footer">专属邀请仅供受邀者使用，请勿公开转发。</footer></main>`;
    } catch {
      if (!alive) return;
      connectionError('请检查网络后重试。这不会影响你的邀请有效期。');
    }
  }
  function connectionError(message: string) {
    if (!alive) return;
    root.innerHTML = `<main class="gate"><p class="eyebrow">BY INVITATION</p><h1>暂时无法连接。</h1><p class="gate-copy">${e(message)}</p><div class="admin-actions invitation-retry"><button class="secondary" id="retry-invitation" type="button">重新连接</button></div></main>`;
    root.querySelector('#retry-invitation')!.addEventListener('click', () => void load());
  }
  void load();
  return () => { alive = false; localToken = ''; controller.abort(); root.replaceChildren(); };
}
