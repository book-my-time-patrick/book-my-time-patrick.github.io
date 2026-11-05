import './admin.css';
import { startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { copyText, escapeHtml as e, formatTime, modeNames, moduleNames } from './ui';

type Time = string | number;
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
interface Permissions { modules: string[]; modes: string[] }
interface Session { id: string; label: string; os: string; browser: string; createdAt: Time; lastSeenAt: Time; expiresAt: Time; current: boolean; recentAuthUntil?: Time }
interface Me { id: string; name: string; session: Session }
interface Invite { id: string; label: string; createdAt: Time; expiresAt: Time; revokedAt: Time | null; lastOpenedAt: Time | null; openCount: number; permissions: Permissions }
interface Passkey { id: string; name: string; createdAt: Time; lastUsedAt: Time | null; backedUp: boolean; deviceType: string }
interface Options<T> { flowId: string; options: T }
interface Setup extends Options<RegistrationOptions> { totpSecret: string; totpUri: string }
class StaleRequestError extends Error {}
class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } }

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return '操作较频繁，请稍等几分钟后再试。';
    if (error.code === 'SETUP_UNAVAILABLE') return '初始化码无效、已过期或设置已经完成，请使用最新提供的专属初始化码。';
    if (error.code === 'REAUTH_REQUIRED') return '请再次验证身份后重试刚才的操作。';
    if (error.code === 'LAST_PASSKEY' || error.code === 'LAST_CREDENTIAL') return '至少需要保留一把通行密钥，请先添加另一把。';
    if (error.status === 503) return '管理服务暂时无法使用，请稍后重试。';
    if (error.status === 401) return '验证未通过或登录已失效。请取最新的动态码后重新验证，已经使用的动态码不能重复使用。';
    if (error.status === 404) return '这条记录已不可用，请刷新列表。';
    if (error.status === 409) return '状态已发生变化，请刷新后重试。';
    if (error.status === 400 || error.status === 403) return '验证未通过。请检查验证码，必要时重新开始。';
    return '操作未完成，请稍后重试。';
  }
  if (error instanceof Error && error.name === 'InvalidStateError') return '这台设备可能已保存本站的通行密钥，请使用其他保存位置或设备。';
  if (error instanceof Error && (error.name === 'SecurityError' || error.name === 'NotSupportedError')) return '当前地址或系统未能使用通行密钥，请使用主站地址与最新版浏览器。';
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError' || error.name === 'WebAuthnError')) return '系统验证已取消或未完成，可以再次尝试。';
  return '暂时无法连接服务，请检查网络后重试。';
}
function epoch(value: Time): number { const time = typeof value === 'number' && value < 1e12 ? value * 1000 : value; return new Date(time).getTime(); }
function localDate(value: Time): string {
  const date = new Date(epoch(value));
  if (!Number.isFinite(date.getTime())) return '';
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
}
function defaultExpiry(): string { return localDate(Date.now() + 30 * 86400000); }
function formValue(form: HTMLFormElement, key: string): string { return String(new FormData(form).get(key) ?? '').trim(); }
function permissionsForm(permissions: Permissions): string {
  return `<fieldset class="admin-permissions"><legend>可见内容</legend><div class="admin-check-grid">${Object.entries(moduleNames).map(([value, label]) => `<label class="admin-checkbox"><input type="checkbox" name="modules" value="${value}" ${permissions.modules.includes(value) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset><fieldset class="admin-permissions"><legend>允许的预约方式</legend><div class="admin-check-grid">${Object.entries(modeNames).map(([value, label]) => `<label class="admin-checkbox"><input type="checkbox" name="modes" value="${value}" ${permissions.modes.includes(value) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>`;
}
function readPermissions(form: HTMLFormElement): Permissions {
  const data = new FormData(form);
  return { modules: data.getAll('modules').map(String).filter(value => Object.hasOwn(moduleNames, value)), modes: data.getAll('modes').map(String).filter(value => Object.hasOwn(modeNames, value)) };
}

export function renderAdmin(root: HTMLElement): () => void {
  const controller = new AbortController();
  let alive = true;
  let revision = 0;
  let identityVersion = 0;
  let me: Me | null = null;
  let tab: 'invites' | 'devices' | 'passkeys' = 'invites';
  let setupToken = /^#\/admin\/setup\/([A-Za-z0-9_-]{32,256})$/.exec(location.hash)?.[1] ?? '';
  let setup: Setup | null = null;
  let currentDialog: HTMLDialogElement | null = null;
  const recentLinks = new Map<string, string>();
  const rootIsCurrent = (version: number) => alive && revision === version;

  function banner(message: string, error = false) {
    if (!alive) return;
    const element = root.querySelector<HTMLElement>('#admin-message');
    if (!element) return;
    element.className = `admin-banner${error ? ' error' : ''}`;
    element.textContent = message;
  }
  function shell(content: string, signedIn = false): number {
    revision += 1;
    root.innerHTML = `<main class="admin-page"><header class="admin-header"><a class="admin-wordmark" href="#/admin"><i aria-hidden="true">↗</i>受邀预约 <span class="stage">管理后台</span></a>${signedIn ? `<div class="admin-header-actions"><span class="admin-current-name">${e(me?.session.label || '当前设备')}</span><button class="text-button" type="button" id="admin-logout">退出登录</button></div>` : '<a class="text-button" href="#/">返回首页</a>'}</header>${content}<footer class="admin-footer">仅供管理员使用。邀请与个人资料由服务端验证访问权限。</footer></main>`;
    root.querySelector('#admin-logout')?.addEventListener('click', () => void action(async () => { await request('/admin/logout', {}); clearPrivate(); showLogin('已退出这台设备。'); }));
    return revision;
  }
  function clearPrivate() {
    identityVersion += 1;
    me = null; setup = null; recentLinks.clear();
    currentDialog?.close(); currentDialog?.remove(); currentDialog = null;
    WebAuthnAbortService.cancelCeremony();
  }
  async function request<T = { ok: boolean }>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const identity = identityVersion;
    const response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: unknown;
    try { data = await response.json(); } catch { throw new ApiError(503, 'INVALID_RESPONSE'); }
    if (!alive || identity !== identityVersion) throw new StaleRequestError();
    if (!response.ok) {
      if (response.status === 401 && me) { clearPrivate(); showLogin('登录已失效，请重新验证。'); }
      const code = data && typeof data === 'object' && 'error' in data ? String(data.error) : 'REQUEST_FAILED';
      throw new ApiError(response.status, code);
    }
    if (!alive) throw new DOMException('View closed', 'AbortError');
    return data as T;
  }
  async function action(operation: () => Promise<void>, button?: HTMLButtonElement) {
    if (!alive || button?.disabled) return;
    const version = revision;
    if (button) button.disabled = true;
    banner('');
    try { await operation(); }
    catch (error) {
      if (!rootIsCurrent(version) || error instanceof StaleRequestError) return;
      if (error instanceof ApiError && error.code === 'REAUTH_REQUIRED' && me) {
        await showReauth();
      } else {
        banner(messageFor(error), true);
        const loading = root.querySelector<HTMLElement>('#admin-content > .admin-loading');
        if (loading) {
          loading.textContent = '未能读取内容。';
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = '重试';
          retry.addEventListener('click', showDashboard); loading.append(document.createElement('br'), retry);
        }
      }
    } finally { if (button?.isConnected) button.disabled = false; }
  }
  function showLogin(message = '', configured = true) {
    me = null; setup = null; recentLinks.clear();
    shell(`<section class="admin-auth"><p class="eyebrow">YOUR PRIVATE DESK</p><h1>欢迎回来。</h1><p class="admin-copy">使用这台设备的通行密钥，或按系统提示通过手机验证。无需输入账号和密码。</p><div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div><section class="admin-card">${configured ? `<form id="login-form"><label class="admin-field">身份验证器的六位动态码<input class="admin-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label><label class="admin-field">这台设备的名称<input name="deviceName" maxlength="80" value="这台设备" autocomplete="off" required></label><label class="admin-checkbox"><input type="checkbox" name="remember" checked>记住这台设备，最长 30 天</label><button class="primary" type="submit">使用通行密钥登录 <span aria-hidden="true">↗</span></button></form><p class="admin-help">Face ID、Touch ID、Windows Hello 或系统提供的手机验证方式均由设备处理。动态码来自你绑定的身份验证器。手机扫码可能需要一些时间；若动态码已刷新，请取新码重新尝试。</p>` : '<h2>后台尚未初始化</h2><p class="admin-copy">请使用单独提供的初始化码，绑定第一把通行密钥与身份验证器。后台网址本身不授予注册权限。</p>'}</section></section>`);
    banner(message, Boolean(message && message !== '已退出这台设备。'));
    const form = root.querySelector<HTMLFormElement>('#login-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('button')!;
      void action(async () => {
        if (!window.PublicKeyCredential) { banner('当前浏览器不支持通行密钥，请使用最新版 Safari、Edge 或 Chrome。', true); return; }
        const code = formValue(form, 'code');
        const deviceName = formValue(form, 'deviceName');
        const remember = new FormData(form).has('remember');
        banner('请完成系统弹出的通行密钥验证。');
        const options = await request<Options<AuthenticationOptions>>('/admin/login/options', {});
        if (!alive) return;
        const response = await startAuthentication({ optionsJSON: options.options });
        await request('/admin/login/verify', { flowId: options.flowId, response, code, deviceName, remember });
        form.reset();
        me = await request<Me>('/admin/me');
        if (!alive) return;
        setupToken = '';
        history.replaceState(null, '', '#/admin');
        showDashboard();
      }, button);
    });
  }
  function showSetup() {
    const version = shell(`<section class="admin-auth"><p class="eyebrow">FIRST-TIME SETUP</p><h1>设置你的管理入口。</h1><p class="admin-copy">使用单独提供的初始化码，绑定通行密钥与身份验证器。后台网址本身不能授权注册。</p><div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div><section class="admin-card" id="setup-card"><h2>准备两种验证方式</h2><p class="admin-copy">准备系统通行密钥与支持六位动态码的身份验证器。初始化码仅首次设置需要，完成后失效，请勿转发。</p><form id="start-setup-form">${setupToken ? '' : '<label class="admin-field">专属初始化码<input type="password" name="setupToken" autocomplete="off" minlength="32" maxlength="256" spellcheck="false" required></label>'}<button class="primary" type="submit" id="start-setup">验证初始化码并开始 <span aria-hidden="true">↗</span></button></form></section></section>`);
    const startForm = root.querySelector<HTMLFormElement>('#start-setup-form')!;
    startForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (new FormData(startForm).has('setupToken')) setupToken = formValue(startForm, 'setupToken');
      void action(async () => {
        if (!window.PublicKeyCredential) { banner('当前浏览器不支持通行密钥，请换用最新版 Safari、Edge 或 Chrome。', true); return; }
        setup = await request<Setup>('/admin/setup/options', { setupToken });
        if (!rootIsCurrent(version)) { setup = null; return; }
        const card = root.querySelector<HTMLElement>('#setup-card')!;
        card.innerHTML = `<h2>01 · 添加身份验证器</h2><p class="admin-copy">在身份验证器中选择「手动输入设置密钥」，账户可填「受邀预约」，使用下方密钥与基于时间的六位验证码。</p><div class="admin-seed" id="setup-secret"></div><div class="admin-actions"><button class="secondary" type="button" id="copy-secret">复制设置密钥</button><button class="text-button" type="button" id="copy-otpauth">复制验证器链接</button></div><p class="admin-help">请在 5 分钟内完成。设置密钥仅在本次设置中显示，不要发送给他人。</p><hr class="admin-divider"><h2>02 · 保存通行密钥</h2><form id="setup-form"><label class="admin-field">这台设备的名称<input name="deviceName" maxlength="80" value="我的第一台设备" autocomplete="off" required></label><label class="admin-field">身份验证器的六位动态码<input class="admin-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label><label class="admin-checkbox"><input type="checkbox" name="remember" checked>记住这台设备，最长 30 天</label><button class="primary" type="submit">保存通行密钥并完成设置 <span aria-hidden="true">↗</span></button></form>`;
        card.querySelector('#setup-secret')!.textContent = setup.totpSecret;
        card.querySelector('#copy-secret')!.addEventListener('click', () => void copySetup(false));
        card.querySelector('#copy-otpauth')!.addEventListener('click', () => void copySetup(true));
        const form = card.querySelector<HTMLFormElement>('#setup-form')!;
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void action(async () => {
            if (!setup) return;
            const currentSetup = setup;
            const code = formValue(form, 'code');
            const deviceName = formValue(form, 'deviceName');
            const remember = new FormData(form).has('remember');
            banner('请按照系统提示保存通行密钥。');
            let registered = false;
            try {
              const response = await startRegistration({ optionsJSON: currentSetup.options });
              registered = true;
              await request('/admin/setup/verify', { flowId: currentSetup.flowId, response, code, deviceName, remember });
              setup = null; setupToken = ''; form.reset();
              history.replaceState(null, '', '#/admin');
              me = await request<Me>('/admin/me');
              showDashboard();
              banner('设置完成。建议在另一台常用设备上再添加一把通行密钥。');
            } catch (error) {
              if (registered && alive) { setup = null; showSetup(); banner('本次设置未完成，请重新开始并使用新生成的验证器密钥。', true); }
              else throw error;
            }
          }, form.querySelector<HTMLButtonElement>('button')!);
        });
      }, startForm.querySelector<HTMLButtonElement>('button')!);
    });
  }
  async function copySetup(uri: boolean) {
    if (!setup) return;
    const copied = await copyText(uri ? setup.totpUri : setup.totpSecret);
    banner(copied ? '已复制。请在身份验证器中添加。' : '浏览器未允许复制，请手动选择设置密钥。', !copied);
  }
  function showDashboard() {
    if (!me || !alive) return;
    const headings = { invites: ['邀请链接', '为每位受邀者设置可见内容与有效期。'], devices: ['登录设备', '查看和管理能够进入后台的浏览器登录。'], passkeys: ['通行密钥', '为常用设备保存登录方式，并管理已经添加的凭据。'] };
    const [title, description] = headings[tab];
    const version = shell(`<section class="admin-intro"><div><p class="eyebrow">PRIVATE APPOINTMENTS</p><h1>${title}</h1><p>${description}</p></div><span class="admin-pill">已验证的管理会话</span></section><nav class="admin-tabs" aria-label="后台管理"><button class="admin-tab" data-tab="invites" role="tab" aria-selected="${tab === 'invites'}">邀请链接</button><button class="admin-tab" data-tab="devices" role="tab" aria-selected="${tab === 'devices'}">登录设备</button><button class="admin-tab" data-tab="passkeys" role="tab" aria-selected="${tab === 'passkeys'}">通行密钥</button></nav><div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div><div id="admin-content"><p class="admin-loading">正在读取…</p></div>`, true);
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab as typeof tab; showDashboard(); }));
    void action(async () => {
      if (tab === 'invites') {
        const data = await request<{ invites: Invite[] }>('/admin/invites');
        if (rootIsCurrent(version)) showInvites(data.invites);
      } else if (tab === 'devices') {
        const data = await request<{ devices: Session[] }>('/admin/devices');
        if (rootIsCurrent(version)) showDevices(data.devices);
      } else {
        const data = await request<{ passkeys: Passkey[] }>('/admin/passkeys');
        if (rootIsCurrent(version)) showPasskeys(data.passkeys);
      }
    });
  }
  function showInvites(invites: Invite[], editing?: Invite) {
    const content = root.querySelector<HTMLElement>('#admin-content');
    if (!content) return;
    const version = revision;
    const permissions = editing?.permissions ?? { modules: ['profile', 'calendar', 'contact'], modes: ['request', 'direct', 'open'] };
    content.innerHTML = `<div class="admin-grid"><section class="admin-card"><div class="admin-section-head"><h2>${editing ? '编辑邀请' : '创建专属链接'}</h2>${editing ? '<button class="text-button" id="cancel-edit" type="button">取消</button>' : ''}</div><form id="invite-form"><label class="admin-field">备注名称<input name="label" maxlength="80" value="${e(editing?.label ?? '')}" placeholder="例如：给一位朋友" required><span class="admin-help">仅你可见，不会显示给受邀者。</span></label><label class="admin-field">有效期至 · 当前设备时区<input name="expiresAt" type="datetime-local" value="${e(editing ? localDate(editing.expiresAt) : defaultExpiry())}" required></label>${permissionsForm(permissions)}<div class="admin-actions"><button class="primary" type="submit">${editing ? '保存设置' : '创建链接'} <span aria-hidden="true">↗</span></button><button class="secondary" id="preview-draft" type="button">预览当前设置</button></div></form><p class="admin-inline-note">邀请链接仅在创建时提供，请复制保存。之后可复制为新链接。预约功能和个人展示将按后续阶段开放。</p></section><section class="admin-card"><div class="admin-section-head"><h2>我的邀请</h2><span class="admin-count">${invites.length} 条</span></div><div id="new-link"></div><div class="admin-list" id="invite-list"></div></section></div>`;
    content.querySelector('#cancel-edit')?.addEventListener('click', () => showInvites(invites));
    const list = content.querySelector<HTMLElement>('#invite-list')!;
    if (!invites.length) list.innerHTML = '<p class="admin-empty">还没有邀请。创建第一条链接，选择对方可以看到的内容。</p>';
    for (const invite of invites) {
      const revoked = invite.revokedAt !== null && invite.revokedAt !== undefined;
      const expired = epoch(invite.expiresAt) <= Date.now();
      const item = document.createElement('article');
      item.className = 'admin-item';
      item.innerHTML = `<div class="admin-item-head"><h3>${e(invite.label)}</h3><span class="admin-pill ${revoked || expired ? 'muted' : ''}">${revoked ? '已撤销' : expired ? '已过期' : epoch(invite.expiresAt) - Date.now() < 3 * 86400000 ? '即将过期' : '有效'}</span></div><p class="admin-item-description">${e(invite.permissions.modules.map(name => moduleNames[name]).filter(Boolean).join(' · ') || '未开放展示模块')}</p><div class="admin-item-meta"><span>有效至 ${e(formatTime(invite.expiresAt))}</span><span>打开 ${e(invite.openCount)} 次 · 最近 ${e(formatTime(invite.lastOpenedAt))}</span></div><div class="admin-actions"><button class="secondary" type="button" data-action="edit" ${revoked ? 'disabled' : ''}>编辑 / 延期</button><button class="secondary" type="button" data-action="clone">复制为新链接</button><button class="text-button" type="button" data-action="preview">预览</button>${recentLinks.has(invite.id) ? '<button class="text-button" type="button" data-action="copy">复制链接</button>' : ''}${revoked ? '' : '<button class="text-button admin-danger" type="button" data-action="revoke">撤销</button>'}</div>`;
      item.querySelector('[data-action="edit"]')!.addEventListener('click', () => { showInvites(invites, invite); content.querySelector<HTMLInputElement>('[name="label"]')?.focus(); });
      item.querySelector('[data-action="clone"]')!.addEventListener('click', (event) => void action(async () => { const result = await request<{ invite: Invite; url: string }>(`/admin/invites/${encodeURIComponent(invite.id)}/clone`, {}); await refreshInvites(result, version); }, event.currentTarget as HTMLButtonElement));
      item.querySelector('[data-action="preview"]')!.addEventListener('click', (event) => void action(() => createPreview({ inviteId: invite.id }), event.currentTarget as HTMLButtonElement));
      item.querySelector('[data-action="copy"]')?.addEventListener('click', () => void showCopyResult(recentLinks.get(invite.id)!));
      item.querySelector('[data-action="revoke"]')?.addEventListener('click', (event) => {
        if (!confirm('撤销后，对方将无法再使用这条邀请链接。确定撤销吗？')) return;
        void action(async () => { await request(`/admin/invites/${encodeURIComponent(invite.id)}`, {}, 'DELETE'); recentLinks.delete(invite.id); await refreshInvites(undefined, version); if (rootIsCurrent(version)) banner('邀请已撤销，立即生效。'); }, event.currentTarget as HTMLButtonElement);
      });
      list.append(item);
    }
    const form = content.querySelector<HTMLFormElement>('#invite-form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const expiresAt = new Date(formValue(form, 'expiresAt'));
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) { banner('请选择未来的有效期。', true); return; }
      const payload = { label: formValue(form, 'label'), expiresAt: expiresAt.toISOString(), permissions: readPermissions(form) };
      void action(async () => {
        const result = await request<{ invite: Invite; url?: string }>(editing ? `/admin/invites/${encodeURIComponent(editing.id)}` : '/admin/invites', payload, editing ? 'PATCH' : 'POST');
        await refreshInvites(result.url ? { invite: result.invite, url: result.url } : undefined, version);
        if (rootIsCurrent(version)) banner(editing ? '邀请设置已保存。' : '邀请已创建，请复制保存专属链接。');
      }, form.querySelector<HTMLButtonElement>('[type="submit"]')!);
    });
    content.querySelector<HTMLButtonElement>('#preview-draft')!.addEventListener('click', (event) => void action(() => createPreview({ permissions: readPermissions(form) }), event.currentTarget as HTMLButtonElement));
  }
  async function refreshInvites(created?: { invite: Invite; url: string }, expectedRevision = revision) {
    if (created) recentLinks.set(created.invite.id, created.url);
    const data = await request<{ invites: Invite[] }>('/admin/invites');
    if (!rootIsCurrent(expectedRevision) || tab !== 'invites' || !me) return;
    showInvites(data.invites);
    if (created) showNewLink(created.url);
  }
  function showNewLink(url: string) {
    const target = root.querySelector<HTMLElement>('#new-link');
    if (!target || !safeShareUrl(url)) return;
    target.innerHTML = '<section class="admin-secret"><h2>专属链接已准备好</h2><p class="admin-copy">请现在复制保存。此链接不会显示在公开首页，也不会再次从服务器取回。</p><input readonly aria-label="新邀请链接"><div class="admin-actions"><button class="secondary" type="button">复制链接</button><a class="text-button" target="_blank" rel="noopener noreferrer">打开链接 ↗</a></div></section>';
    target.querySelector<HTMLInputElement>('input')!.value = url;
    target.querySelector<HTMLAnchorElement>('a')!.href = url;
    target.querySelector('button')!.addEventListener('click', () => void showCopyResult(url));
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function safeShareUrl(value: string): boolean {
    try { const url = new URL(value); return url.origin === location.origin && /^#\/i\/[A-Za-z0-9_-]+$/.test(url.hash); } catch { return false; }
  }
  async function showCopyResult(url: string) { const ok = await copyText(url); banner(ok ? '已复制链接。' : '浏览器未允许复制，请选中链接手动复制。', !ok); }
  async function createPreview(payload: { inviteId?: string; permissions?: Permissions }) {
    const version = revision;
    const result = await request<{ url: string; expiresAt: Time }>('/admin/preview', payload);
    if (!rootIsCurrent(version)) return;
    if (!safeShareUrl(result.url)) throw new ApiError(503, 'INVALID_PREVIEW');
    showLinkDialog(result.url, '受邀者预览', `预览在 ${formatTime(result.expiresAt)} 失效，不计访问次数，不创建预约或发送邮件。`);
  }
  function showLinkDialog(url: string, title: string, description: string) {
    currentDialog?.remove();
    const dialog = document.createElement('dialog'); currentDialog = dialog; dialog.className = 'admin-dialog';
    dialog.innerHTML = `<h2>${e(title)}</h2><p class="admin-copy">${e(description)}</p><input readonly aria-label="预览链接"><div class="admin-actions admin-dialog-actions"><button class="text-button" type="button">关闭</button><a class="secondary" target="_blank" rel="noopener noreferrer">打开预览 ↗</a></div>`;
    dialog.querySelector<HTMLInputElement>('input')!.value = url;
    dialog.querySelector<HTMLAnchorElement>('a')!.href = url;
    dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); if (currentDialog === dialog) currentDialog = null; });
    root.append(dialog); dialog.showModal();
  }
  function showDevices(devices: Session[]) {
    const version = revision;
    const content = root.querySelector<HTMLElement>('#admin-content'); if (!content) return;
    content.innerHTML = `<section class="admin-card"><div class="admin-section-head"><h2>允许进入后台的登录</h2><button class="secondary" type="button" id="revoke-others">退出其他所有登录</button></div><p class="admin-copy">设备名称可修改。同一台电脑的不同浏览器会分别显示；这里不记录 IP 明细或硬件指纹。</p><div class="admin-list" id="devices-list"></div></section><p class="admin-inline-note">移除登录会立即阻止它后续访问后台。通行密钥在另一页管理，移除登录不会从设备的密码管理器中删除通行密钥。</p>`;
    content.querySelector<HTMLButtonElement>('#revoke-others')!.addEventListener('click', (event) => {
      if (!confirm('确定退出当前设备之外的所有后台登录吗？')) return;
      void action(async () => { await request('/admin/devices/revoke-others', {}); if (rootIsCurrent(version)) showDashboard(); }, event.currentTarget as HTMLButtonElement);
    });
    const list = content.querySelector('#devices-list')!;
    if (!devices.length) list.innerHTML = '<p class="admin-empty">没有可用的设备记录。</p>';
    for (const device of devices) {
      const item = document.createElement('article'); item.className = 'admin-item';
      item.innerHTML = `<div class="admin-item-head"><h3>${e(device.label)}</h3>${device.current ? '<span class="admin-pill">当前设备</span>' : ''}</div><p class="admin-item-description">${e(device.os)} · ${e(device.browser)}</p><div class="admin-item-meta"><span>首次登录 ${e(formatTime(device.createdAt))}</span><span>最近使用 ${e(formatTime(device.lastSeenAt))}</span><span>有效至 ${e(formatTime(device.expiresAt))}</span></div><form class="admin-device-rename"><label class="admin-field">设备名称<input name="label" maxlength="80" value="${e(device.label)}" required></label><div class="admin-actions"><button class="secondary" type="submit">保存名称</button><button class="text-button admin-danger" type="button">${device.current ? '退出当前登录' : '移除登录'}</button></div></form>`;
      const form = item.querySelector<HTMLFormElement>('form')!;
      form.addEventListener('submit', (event) => { event.preventDefault(); void action(async () => { await request(`/admin/devices/${encodeURIComponent(device.id)}`, { label: formValue(form, 'label') }, 'PATCH'); const data = await request<{ devices: Session[] }>('/admin/devices'); if (rootIsCurrent(version) && me && tab === 'devices') { showDevices(data.devices); banner('设备名称已保存。'); } }, form.querySelector<HTMLButtonElement>('[type="submit"]')!); });
      item.querySelector<HTMLButtonElement>('[type="button"]')!.addEventListener('click', (event) => {
        if (!confirm(device.current ? '确定退出当前设备吗？' : '移除后，这个浏览器需要重新验证才能登录。确定移除吗？')) return;
        void action(async () => { await request(`/admin/devices/${encodeURIComponent(device.id)}`, {}, 'DELETE'); if (device.current) { clearPrivate(); showLogin('已退出这台设备。'); } else if (rootIsCurrent(version)) { showDashboard(); } }, event.currentTarget as HTMLButtonElement);
      });
      list.append(item);
    }
  }
  function showPasskeys(passkeys: Passkey[]) {
    const version = revision;
    const content = root.querySelector<HTMLElement>('#admin-content'); if (!content) return;
    content.innerHTML = `<section class="admin-card"><div class="admin-section-head"><h2>已保存的通行密钥</h2><span class="admin-count">${passkeys.length} 把</span></div><p class="admin-copy">可以在另一台常用电脑或手机上登录后，为它添加通行密钥。系统支持的同步或手机验证路径由设备提供。</p><form id="add-passkey"><div class="admin-form-row"><label class="admin-field">新通行密钥的名称<input name="deviceName" maxlength="80" placeholder="例如：工作电脑" required></label><div class="admin-actions"><button class="secondary" type="submit">添加通行密钥 ↗</button></div></div></form><div class="admin-list" id="passkey-list"></div></section><p class="admin-inline-note">至少保留一把可用凭据。撤销已同步的通行密钥，会让它的所有副本在本站失效；不会删除设备密码管理器中的条目。</p>`;
    const form = content.querySelector<HTMLFormElement>('#add-passkey')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void action(async () => {
        const deviceName = formValue(form, 'deviceName');
        const options = await request<Options<RegistrationOptions>>('/admin/passkeys/options', {});
        const response = await startRegistration({ optionsJSON: options.options });
        await request('/admin/passkeys/verify', { flowId: options.flowId, response, deviceName });
        if (rootIsCurrent(version)) { showDashboard(); banner('已添加通行密钥。'); }
      }, form.querySelector<HTMLButtonElement>('button')!);
    });
    const list = content.querySelector('#passkey-list')!;
    if (!passkeys.length) list.innerHTML = '<p class="admin-empty">暂无通行密钥记录，请刷新后重试。</p>';
    for (const passkey of passkeys) {
      const item = document.createElement('article'); item.className = 'admin-item';
      item.innerHTML = `<div class="admin-item-head"><h3>${e(passkey.name)}</h3><span class="admin-pill">${passkey.backedUp ? '可同步凭据' : '设备凭据'}</span></div><div class="admin-item-meta"><span>添加于 ${e(formatTime(passkey.createdAt))}</span><span>最近使用 ${e(formatTime(passkey.lastUsedAt))}</span></div><form><label class="admin-field">凭据名称<input name="name" maxlength="80" value="${e(passkey.name)}" required></label><div class="admin-actions"><button class="secondary" type="submit">保存名称</button><button class="text-button admin-danger" type="button" ${passkeys.length <= 1 ? 'disabled' : ''}>撤销通行密钥</button></div></form>`;
      const rename = item.querySelector<HTMLFormElement>('form')!;
      rename.addEventListener('submit', (event) => { event.preventDefault(); void action(async () => { await request(`/admin/passkeys/${encodeURIComponent(passkey.id)}`, { name: formValue(rename, 'name') }, 'PATCH'); if (rootIsCurrent(version)) showDashboard(); }, rename.querySelector<HTMLButtonElement>('[type="submit"]')!); });
      item.querySelector<HTMLButtonElement>('[type="button"]')!.addEventListener('click', (event) => {
        if (!confirm('确定撤销这把通行密钥吗？它的同步副本也将无法在本站登录，相关登录会话将退出。')) return;
        void action(async () => { await request(`/admin/passkeys/${encodeURIComponent(passkey.id)}`, {}, 'DELETE'); const current = await request<Me>('/admin/me'); if (rootIsCurrent(version)) { me = current; showDashboard(); } }, event.currentTarget as HTMLButtonElement);
      });
      list.append(item);
    }
  }
  async function showReauth(): Promise<void> {
    if (!alive || !me || currentDialog) return;
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog'); currentDialog = dialog; dialog.className = 'admin-dialog';
      dialog.innerHTML = '<h2>再确认一次，是你本人。</h2><p class="admin-copy">这项操作需要近期身份验证。完成后，刚才填写的内容会保留。</p><form><label class="admin-field">身份验证器的六位动态码<input class="admin-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label><p class="admin-copy" role="status" id="reauth-message"></p><div class="admin-actions"><button class="text-button" id="cancel-reauth" type="button">取消</button><button class="primary" type="submit">使用通行密钥验证</button></div></form>';
      dialog.querySelector('#cancel-reauth')!.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => { dialog.remove(); if (currentDialog === dialog) currentDialog = null; WebAuthnAbortService.cancelCeremony(); resolve(); }, { once: true });
      const form = dialog.querySelector<HTMLFormElement>('form')!;
      form.addEventListener('submit', (event) => {
        event.preventDefault(); const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!; if (button.disabled) return; button.disabled = true;
        void (async () => {
          try {
            const options = await request<Options<AuthenticationOptions>>('/admin/reauth/options', {});
            const response = await startAuthentication({ optionsJSON: options.options });
            await request('/admin/reauth/verify', { flowId: options.flowId, response, code: formValue(form, 'code') });
            form.reset(); dialog.close(); banner('身份验证完成，请再次点击刚才的操作。');
          } catch (error) { if (dialog.isConnected) dialog.querySelector('#reauth-message')!.textContent = messageFor(error); }
          finally { button.disabled = false; }
        })();
      });
      root.append(dialog); dialog.showModal();
    });
  }
  async function initialize() {
    const version = shell('<p class="admin-loading">正在确认管理入口…</p>');
    try {
      const status = await request<{ configured: boolean }>('/admin/status');
      if (!rootIsCurrent(version)) return;
      if (!status.configured) { showSetup(); return; }
      if (setupToken) { setupToken = ''; history.replaceState(null, '', '#/admin'); }
      try { me = await request<Me>('/admin/me'); if (rootIsCurrent(version)) showDashboard(); }
      catch (error) { if (rootIsCurrent(version)) { if (error instanceof ApiError && error.status === 401) showLogin(); else showUnavailable(error); } }
    } catch (error) { if (rootIsCurrent(version)) showUnavailable(error); }
  }
  function showUnavailable(error: unknown) {
    shell(`<section class="admin-auth"><p class="eyebrow">PRIVATE DESK</p><h1>暂时无法连接后台。</h1><p class="admin-copy">${e(messageFor(error))}</p><button class="secondary" id="retry-admin" type="button">重新连接</button></section>`);
    root.querySelector('#retry-admin')!.addEventListener('click', () => void initialize());
  }
  let checkingSession = false;
  async function checkSession() {
    if (!alive || !me || checkingSession || document.hidden) return;
    checkingSession = true;
    const version = revision;
    const sessionId = me.session.id;
    try { const current = await request<Me>('/admin/me'); if (rootIsCurrent(version) && me?.session.id === sessionId) me = current; }
    catch (error) { if (rootIsCurrent(version) && me && !(error instanceof StaleRequestError)) banner('暂时无法确认登录状态，请检查网络。', true); }
    finally { checkingSession = false; }
  }
  const visibility = () => { if (!document.hidden) void checkSession(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pageshow', visibility);
  const interval = window.setInterval(() => void checkSession(), 45000);
  void initialize();
  return () => {
    alive = false; controller.abort(); clearPrivate(); setupToken = '';
    window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', visibility);
    root.replaceChildren();
  };
}
