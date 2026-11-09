import './admin.css';
import { startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { copyText, escapeHtml as e, formatTime, modeNames, moduleNames } from './ui';
import { createSetupQr } from './qr';
import { renderBookingInbox, renderCalendarLocation, renderMailSettings } from './admin-m2';
import type { BookingView, CalendarLocationSettings, MailSettings, PanelActions, RequestFilter } from './admin-m2';
import { renderCalendarConnections } from './admin-calendars';
import type { CalendarConnections } from './admin-calendars';
import { inviteStatus } from './invite-status';
import type { InviteState } from './invite-status';

type Time = string | number;
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegistrationResult = Awaited<ReturnType<typeof startRegistration>>;
type LoginMethod = 'passkey' | 'password';
interface DeviceChoice { deviceName: string; remember: boolean }
interface Permissions { modules: string[]; modes: string[]; hideBusy?: true }
interface Session { id: string; label: string; os: string; browser: string; method: LoginMethod; createdAt: Time; lastSeenAt: Time; expiresAt: Time; current: boolean; recentAuthUntil?: Time }
interface Me { id: string; name: string; session: Session }
interface PasswordSettings { enabled: boolean; revision: string | null; updatedAt: number | null }
interface GeneratedPassword { password: string; revision: string; updatedAt: number }
interface Invite { id: string; label: string; createdAt: Time; expiresAt: Time; revokedAt: Time | null; lastOpenedAt: Time | null; openCount: number; permissions: Permissions }
interface InviteList { invites: Invite[]; now: number }
interface Passkey { id: string; name: string; createdAt: Time; lastUsedAt: Time | null; backedUp: boolean; deviceType: string }
interface Options<T> { flowId: string; options: T }
interface Setup extends Options<RegistrationOptions> { totpSecret: string; totpUri: string }
class StaleRequestError extends Error {}
class ApiError extends Error {
  constructor(public status: number, public code: string, public phase = 'ADMIN_API', public ray = '') { super(code); }
}
function diagnosticFor(error: unknown): string {
  return JSON.stringify(error instanceof ApiError ? { error: error.code, httpStatus: error.status, phase: error.phase, ...(error.ray ? { cfRay: error.ray } : {}) } : { error: 'CLIENT_AUTHENTICATION_ERROR', phase: 'SYSTEM_AUTH' });
}
function requestPhase(path: string): string {
  if (path.startsWith('/admin/requests')) return 'BOOKING_ADMIN';
  if (path.startsWith('/admin/mail')) return 'MAIL_ADMIN';
  if (path.startsWith('/admin/calendar-sources')) return 'CALENDAR_ADMIN';
  const phases: Record<string, string> = { '/admin/setup/options': 'SETUP_START', '/admin/setup/verify': 'SETUP_VERIFY', '/admin/login/options': 'LOGIN_START', '/admin/login/verify': 'LOGIN_VERIFY', '/admin/login/password': 'PASSWORD_LOGIN', '/admin/password': 'PASSWORD_SETTINGS', '/admin/reauth/options': 'REAUTH_START', '/admin/reauth/verify': 'REAUTH_VERIFY', '/admin/me': 'SESSION_CHECK', '/admin/status': 'ADMIN_STATUS' };
  return phases[path] ?? 'ADMIN_API';
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SETUP_FLOW_EXPIRED') return '这次绑定流程已过期，请重新开始绑定。';
    if (error.code === 'PASSKEY_CONTEXT_NOT_SUPPORTED') return '请在独立 Chrome 或 Safari 窗口直接打开主站后台，应用内嵌页面不能完成此验证。';
    if (error.code === 'PASSKEY_VERIFICATION_FAILED') return '系统已返回通行密钥，但服务端未能验证。请重新开始，并保留下面的诊断信息。';
    if (error.code === 'TOTP_INVALID') return '动态码不正确或已经刷新。请使用刚扫码添加的账户里的最新六位码，无需重新扫码。';
    if (error.code === 'SETUP_STORAGE_FAILED') return '服务端暂时未能保存绑定。请保留诊断信息，稍后再试。';
    if (error.code === 'NETWORK_ERROR') return '暂时无法连接认证服务，请检查网络后重试。';
    if (error.code === 'WORKER_CPU_LIMIT') return '认证服务触发运行时计算限制，未能完成请求。请保留诊断信息。';
    if (error.status === 429) return '操作较频繁，请稍等几分钟后再试。';
    if (error.code === 'SETUP_UNAVAILABLE') return '初始化码无效、已过期或设置已经完成，请使用最新提供的专属初始化码。';
    if (error.code === 'REAUTH_REQUIRED') return '请再次验证身份后重试刚才的操作。';
    if (error.code === 'PASSKEY_LOGIN_REQUIRED') return '请退出当前登录，然后使用通行密钥登录以管理密码。';
    if (error.code === 'PASSWORD_CHANGED') return '密码状态已更新。请重新打开「登录密码」，查看状态后再操作。';
    if (error.code === 'BOOKING_CHANGED') return '这条申请已更新。请刷新预约列表后再处理。';
    if (error.code === 'SLOT_CONFLICT') return '这个时间与站内已确认的预约重叠。请建议其他时间。';
    if (error.code === 'SLOT_UNAVAILABLE') return '这个时间已过去或超出申请范围。请选择未来工作日的其他时间。';
    if (error.code === 'INVALID_CITY') return '请填写不超过 24 个字符的城市名称，例如深圳或香港。';
    if (error.code === 'INVALID_DATE_RANGE') return '请选择北京时间今天起 30 天内的日期，结束日期不能早于开始日期。';
    if (error.code === 'CALENDAR_AUTH_REQUIRED') return '日历服务拒绝授权。请核对 App 专用密码或 Microsoft 授权。';
    if (error.code === 'CALENDAR_UNSUPPORTED') return '这本日历暂未提供可读取的忙闲数据。请选择其他日历，或稍后重试。';
    if (error.code === 'CALENDAR_RESPONSE_INVALID') return '日历返回的数据不完整，暂不能用于预约。';
    if (error.code === 'CALENDAR_LIMIT_EXCEEDED') return '日历数据过多，暂时无法完成同步。';
    if (error.code === 'CALENDAR_UNAVAILABLE') return '暂时无法连接日历服务，请稍后重试。';
    if (error.code === 'CALENDAR_CONFIG_INVALID') return '请核对日历账户类型和 Microsoft 应用配置。';
    if (error.code === 'CALENDAR_FLOW_EXPIRED') return '这次 Microsoft 授权已过期或已使用。请重新开始授权。';
    if (error.code === 'CALENDAR_CHANGED') return '另一台设备已更改连接，请读取最新状态后重试。';
    if (error.code === 'CALENDAR_NOT_READY') return '请先确认 iCloud 与 Outlook 都已同步，并验证送达邮箱。';
    if (error.code === 'MAIL_NOT_CONFIGURED') return '请先保存已验证域名的发件地址和 Resend 密钥。';
    if (error.code === 'MAIL_SEND_FAILED') return '发信服务未确认接收。请检查 Resend 的发件域名和密钥，再重试。';
    if (error.code === 'MAILBOX_UNVERIFIED') return '请先用验证码验证这个邮箱。';
    if (error.code === 'MAILBOX_IN_USE') return '这个邮箱仍用于送达或通知。请先改用其他邮箱或清除邀请覆盖。';
    if (error.code === 'CODE_INVALID') return '验证码错误或已过期。请核对最近收到的验证码，或重新发送。';
    if (error.code === 'MAILBOX_EXISTS') return '这个邮箱已添加，请在邮箱列表中查看。';
    if (error.code === 'MAILBOX_LIMIT') return '最多可添加 20 个邮箱。请先移除一个不用的邮箱。';
    if (error.code === 'MAILBOX_ALREADY_VERIFIED') return '这个邮箱已经验证。请刷新邮箱设置。';
    if (error.code === 'MAIL_SETTINGS_CHANGED') return '邮箱设置已更新。请重新打开「邮箱设置」后再操作。';
    if (error.code === 'INVALID_INPUT' && ['BOOKING_ADMIN', 'MAIL_ADMIN', 'CALENDAR_ADMIN'].includes(error.phase)) return '请核对填写的内容后重试。';
    if (error.code === 'LAST_PASSKEY' || error.code === 'LAST_CREDENTIAL') return '至少需要保留一把通行密钥，请先添加另一把。';
    if (error.status === 503) return '管理服务暂时无法使用，请稍后重试。';
    if (error.status === 401 && error.phase === 'PASSWORD_LOGIN') return '密码验证未通过。请确认密码，或改用通行密钥。';
    if (error.status === 401) return '验证未通过或登录已失效。请选择此前成功绑定的通行密钥，重新进行系统验证。';
    if (error.status === 404) return '这条记录已不可用，请刷新列表。';
    if (error.status === 409) return '状态已发生变化，请刷新后重试。';
    if (error.status === 400 || error.status === 403) return '验证未通过。请重新进行系统验证，或保留下方诊断信息。';
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
const inviteStateLabels: Record<InviteState, string> = { active: '有效', expiring: '即将过期', expired: '已过期', revoked: '已撤销' };
function isRevoked(invite: Invite): boolean { return invite.revokedAt !== null && invite.revokedAt !== undefined; }
function formValue(form: HTMLFormElement, key: string): string { return String(new FormData(form).get(key) ?? '').trim(); }
function permissionsForm(permissions: Permissions): string {
  return `<fieldset class="admin-permissions"><legend>可见内容</legend><div class="admin-check-grid">${Object.entries(moduleNames).map(([value, label]) => `<label class="admin-checkbox"><input type="checkbox" name="modules" value="${value}" ${permissions.modules.includes(value) ? 'checked' : ''}>${label}</label>`).join('')}</div><label class="admin-checkbox"><input type="checkbox" name="hideBusy"${permissions.hideBusy ? ' checked' : ''}>把已占用显示为未开放</label></fieldset><fieldset class="admin-permissions"><legend>允许的预约方式</legend><div class="admin-check-grid">${Object.entries(modeNames).map(([value, label]) => `<label class="admin-checkbox"><input type="checkbox" name="modes" value="${value}" ${permissions.modes.includes(value) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>`;
}
function readPermissions(form: HTMLFormElement): Permissions {
  const data = new FormData(form);
  return { modules: data.getAll('modules').map(String).filter(value => Object.hasOwn(moduleNames, value)), modes: data.getAll('modes').map(String).filter(value => Object.hasOwn(modeNames, value)),
    ...(data.has('hideBusy') ? { hideBusy: true as const } : {}) };
}

export function renderAdmin(root: HTMLElement): () => void {
  const controller = new AbortController();
  let alive = true;
  let revision = 0;
  let identityVersion = 0;
  let me: Me | null = null;
  const returnPrefix = '#/admin/calendar-return?';
  let calendarReturn = location.hash.startsWith(returnPrefix) ? new URLSearchParams(location.hash.slice(returnPrefix.length)) : null;
  let tab: 'invites' | 'devices' | 'passkeys' | 'password' | 'requests' | 'mail' | 'location' | 'calendars' = calendarReturn ? 'calendars' : 'invites';
  if (calendarReturn) history.replaceState(null, '', '#/admin');
  let requestFilter: RequestFilter = 'pending';
  let passwordEnabled = false;
  let setupToken = /^#\/admin\/setup\/([A-Za-z0-9_-]{32,256})$/.exec(location.hash)?.[1] ?? '';
  let setup: Setup | null = null;
  let currentDialog: HTMLDialogElement | null = null;
  let setupSuccessVisible = false;
  let pendingSetup: { flow: Setup; response: RegistrationResult; device: DeviceChoice } | null = null;
  let setupSubmitting = false;
  const recentLinks = new Map<string, string>();
  let inviteNow = () => Date.now();
  let displayedInvites = new Map<string, Invite>();
  let inviteExpiryTimer = 0;
  let refreshInviteBadges: ((invites?: Invite[]) => void) | null = null;
  let syncingInviteClock = false;
  const rootIsCurrent = (version: number) => alive && revision === version;

  function banner(message: string, error = false) {
    if (!alive) return;
    const element = root.querySelector<HTMLElement>('#admin-message');
    if (!element) return;
    element.className = `admin-banner${error ? ' error' : ''}`;
    element.textContent = message;
  }
  function reportError(error: unknown, fallback?: string, target = root.querySelector<HTMLElement>('#admin-message')) {
    if (!alive || !target) return;
    target.className = 'admin-banner error';
    target.textContent = fallback ?? messageFor(error);
    const detail = document.createElement('p'); detail.className = 'admin-diagnostic'; detail.textContent = diagnosticFor(error);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '复制诊断信息';
    button.addEventListener('click', () => { const text = detail.textContent ?? ''; void copyText(text).then(ok => { if (alive && button.isConnected) button.textContent = ok ? '诊断信息已复制' : '请手动复制上方诊断信息'; }); });
    target.append(detail, button);
  }
  function shell(content: string, signedIn = false): number {
    stopInviteWatch();
    revision += 1;
    root.innerHTML = `<main class="admin-page"><header class="admin-header"><a class="admin-wordmark" href="#/admin"><i aria-hidden="true">↗</i>受邀预约 <span class="stage">管理后台</span></a>${signedIn ? `<div class="admin-header-actions"><span class="admin-current-name">${e(me?.session.label || '当前设备')}</span><button class="text-button" type="button" id="admin-logout">退出登录</button></div>` : '<a class="text-button" href="#/">返回首页</a>'}</header>${content}<footer class="admin-footer">仅供管理员使用。邀请与个人资料由服务端验证访问权限。</footer></main>`;
    root.querySelector('#admin-logout')?.addEventListener('click', () => void action(async () => { await request('/admin/logout', {}); clearPrivate(); await initialize('已退出这台设备。'); }));
    return revision;
  }
  function clearPrivate() {
    stopInviteWatch();
    identityVersion += 1;
    me = null; setup = null; pendingSetup = null; setupSubmitting = false; recentLinks.clear(); setupSuccessVisible = false;
    currentDialog?.close(); currentDialog?.remove(); currentDialog = null;
    WebAuthnAbortService.cancelCeremony();
  }
  async function request<T = { ok: boolean }>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const identity = identityVersion;
    const phase = requestPhase(path);
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        method, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (!alive || identity !== identityVersion || error instanceof Error && error.name === 'AbortError') throw new StaleRequestError();
      throw new ApiError(0, 'NETWORK_ERROR', phase);
    }
    const rayHeader = response.headers.get('cf-ray') ?? '';
    const ray = /^[a-f0-9]{8,32}(?:-[A-Z]{3,5})?$/i.test(rayHeader) ? rayHeader : '';
    let data: unknown;
    try {
      const raw = await response.text();
      try { data = JSON.parse(raw); }
      catch {
        if (response.status === 401 && me && !path.endsWith('/verify')) { clearPrivate(); void initialize('登录已失效，请重新验证。'); }
        throw new ApiError(response.status, /(?:error(?:\s+code)?\s*:?\s*1102\b|cf-error-code[^>]*>\s*1102\b)/i.test(raw) ? 'WORKER_CPU_LIMIT' : 'INVALID_RESPONSE', phase, ray);
      }
    } catch (error) {
      if (!alive || identity !== identityVersion) throw new StaleRequestError();
      if (error instanceof ApiError) throw error;
      throw new ApiError(response.status, 'NETWORK_ERROR', phase, ray);
    }
    if (!alive || identity !== identityVersion) throw new StaleRequestError();
    if (!response.ok) {
      const returned = data && typeof data === 'object' && 'error' in data ? String(data.error) : '';
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(returned) ? returned : 'REQUEST_FAILED';
      const proofFailure = path.endsWith('/verify') && ['AUTHENTICATION_FAILED', 'TOTP_INVALID', 'PASSKEY_VERIFICATION_FAILED', 'PASSKEY_CONTEXT_NOT_SUPPORTED', 'SETUP_FLOW_EXPIRED'].includes(code);
      if (response.status === 401 && me && !proofFailure) { clearPrivate(); void initialize('登录已失效，请重新验证。'); }
      throw new ApiError(response.status, code, phase, ray);
    }
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
        reportError(error);
        const loading = root.querySelector<HTMLElement>('#admin-content > .admin-loading');
        if (loading) {
          loading.textContent = '未能读取内容。';
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = '重试';
          retry.addEventListener('click', showDashboard); loading.append(document.createElement('br'), retry);
        }
      }
    } finally { if (button?.isConnected) button.disabled = false; }
  }
  function showLogin(message = '', device: DeviceChoice = { deviceName: '这台设备', remember: true }, method: LoginMethod = 'passkey') {
    me = null; setup = null; pendingSetup = null; recentLinks.clear();
    const usePassword = method === 'password' && passwordEnabled;
    const label = usePassword ? '使用密码登录' : '使用通行密钥登录';
    const intro = usePassword ? '输入你在后台生成并保存的登录密码。' : '使用已绑定的通行密钥，由系统验证身份。';
    const passwordField = '<label class="admin-field">登录密码<input name="password" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" maxlength="64" required></label>';
    const switchLabel = usePassword ? '改用通行密钥' : '使用密码登录';
    const passkeyHelp = '系统会提供 Touch ID、Face ID、Windows Hello 或设备解锁等方式。如有多把同名通行密钥，请选择此前成功绑定的一把。';
    const version = shell(`
      <section class="admin-auth">
        <p class="eyebrow">YOUR PRIVATE DESK</p>
        <h1>欢迎回来。</h1>
        <p class="admin-copy">${intro}</p>
        <div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div>
        <section class="admin-card">
          <form id="login-form" method="post">
            ${usePassword ? passwordField : ''}
            <label class="admin-field">这台设备的名称<input name="deviceName" maxlength="80" value="${e(device.deviceName)}" autocomplete="off" required></label>
            <label class="admin-checkbox"><input type="checkbox" name="remember" ${device.remember ? 'checked' : ''}>记住这台设备，最长 6 个月</label>
            <button class="primary" type="submit">${label} <span aria-hidden="true">↗</span></button>
            ${passwordEnabled ? `<button class="text-button admin-login-switch" type="button" id="login-method-switch">${switchLabel}</button>` : ''}
          </form>
          <p class="admin-help">${usePassword ? '' : passkeyHelp}关闭页面后，有效期内可以直接返回。点击退出会结束当前登录。</p>
        </section>
      </section>`);
    banner(message, Boolean(message && message !== '已退出这台设备。'));
    const form = root.querySelector<HTMLFormElement>('#login-form')!;
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const switchMethod = form.querySelector<HTMLButtonElement>('#login-method-switch');
    const passwordInput = form.querySelector<HTMLInputElement>('[name="password"]');
    const readDevice = () => ({ deviceName: formValue(form, 'deviceName'), remember: new FormData(form).has('remember') });
    switchMethod?.addEventListener('click', () => showLogin('', readDevice(), usePassword ? 'passkey' : 'password'));
    passwordInput?.focus();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      if (switchMethod) switchMethod.disabled = true;
      void action(async () => {
        const chosen = readDevice();
        let verification: Promise<unknown>;
        if (passwordInput) {
          banner('正在验证密码。');
          verification = request('/admin/login/password', { password: passwordInput.value, ...chosen });
          passwordInput.value = '';
        } else {
          if (!window.PublicKeyCredential) { banner('当前浏览器不支持通行密钥，请使用最新版 Safari、Edge 或 Chrome。', true); return; }
          banner('请完成系统弹出的通行密钥验证。');
          const flow = await request<Options<AuthenticationOptions>>('/admin/login/options', {});
          if (!rootIsCurrent(version)) return;
          const response = await startAuthentication({ optionsJSON: flow.options });
          if (!rootIsCurrent(version)) return;
          verification = request('/admin/login/verify', { flowId: flow.flowId, response, ...chosen });
        }
        let verified = false;
        try {
          await verification;
          verified = true;
          const account = await request<Me>('/admin/me');
          if (!rootIsCurrent(version)) return;
          enterDashboard(account);
        } catch (error) {
          if (!rootIsCurrent(version) || error instanceof StaleRequestError) return;
          if (verified || error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
            try {
              const account = await request<Me>('/admin/me');
              if (!rootIsCurrent(version)) return;
              enterDashboard(account); return;
            } catch (confirmation) {
              if (!rootIsCurrent(version) || confirmation instanceof StaleRequestError) return;
              if (!(confirmation instanceof ApiError && confirmation.status === 401)) { showLoginConnectionRetry(error, chosen, method); return; }
            }
          }
          showLogin('', chosen, method); reportError(error);
        }
      }, submit).finally(() => { if (switchMethod?.isConnected) switchMethod.disabled = false; });
    });
  }
  function enterDashboard(account: Me) {
    me = account; setupToken = ''; history.replaceState(null, '', '#/admin'); showDashboard();
  }
  function showLoginConnectionRetry(error: unknown, device: DeviceChoice, method: LoginMethod) {
    const version = shell('<section class="admin-auth"><p class="eyebrow">CONFIRM YOUR SESSION</p><h1>请重新确认连接。</h1><p class="admin-copy">暂时未能确认登录结果。请先重新连接后台，检查登录状态。</p><div id="admin-message" class="admin-banner" role="status"></div><button class="secondary" id="confirm-login" type="button">重新连接后台</button></section>');
    reportError(error);
    const button = root.querySelector<HTMLButtonElement>('#confirm-login')!;
    button.addEventListener('click', () => void action(async () => {
      try { const account = await request<Me>('/admin/me'); if (rootIsCurrent(version)) enterDashboard(account); }
      catch (failure) { if (!rootIsCurrent(version) || failure instanceof StaleRequestError) return; if (failure instanceof ApiError && failure.status === 401) { showLogin('', device, method); reportError(failure); } else throw failure; }
    }, button));
  }
  function showSetup() {
    pendingSetup = null;
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
        card.innerHTML = `<h2>01 · 扫码绑定身份验证器</h2><p class="admin-copy">用身份验证器扫描下方二维码，获取六位动态码。Microsoft Authenticator 中选择「添加账户 → 其他账户」后扫码。</p><div class="admin-setup-qr" id="setup-qr" role="status" aria-live="polite">正在生成二维码…</div><p class="admin-help">二维码在当前浏览器生成，不会将设置密钥发送给外部二维码服务。</p><details class="admin-setup-manual" id="setup-manual"><summary>无法扫码？手动添加</summary><p class="admin-copy">如果正在同一部手机上设置，可复制下方设置密钥，在身份验证器中手动添加，账户名称填写「受邀预约」。</p><div class="admin-seed" id="setup-secret"></div><div class="admin-actions"><button class="secondary" type="button" id="copy-secret">复制设置密钥</button><button class="text-button" type="button" id="copy-otpauth">复制验证器链接</button></div></details><p class="admin-help">请在 5 分钟内完成。二维码与设置密钥只在本次设置中显示，不要发送给他人。</p><hr class="admin-divider"><h2>02 · 保存通行密钥</h2><form id="setup-form"><label class="admin-field">这台设备的名称<input name="deviceName" maxlength="80" value="我的第一台设备" autocomplete="off" required></label><label class="admin-checkbox"><input type="checkbox" name="remember" checked>记住这台设备，最长 6 个月</label><p class="admin-help">先完成系统保存，下一步再输入最新动态码。</p><button class="primary" type="submit">保存通行密钥 <span aria-hidden="true">↗</span></button></form>`;
        const currentSetup = setup;
        const qr = card.querySelector<HTMLElement>('#setup-qr')!;
        void createSetupQr(currentSetup.totpUri).then((image) => {
          if (rootIsCurrent(version) && setup === currentSetup && qr.isConnected) qr.replaceChildren(image);
        }).catch(() => {
          if (!rootIsCurrent(version) || setup !== currentSetup || !qr.isConnected) return;
          qr.textContent = '二维码暂时无法生成，请使用下方设置密钥手动添加。';
          card.querySelector<HTMLDetailsElement>('#setup-manual')!.open = true;
        });
        card.querySelector('#setup-secret')!.textContent = setup.totpSecret;
        card.querySelector('#copy-secret')!.addEventListener('click', () => void copySetup(false));
        card.querySelector('#copy-otpauth')!.addEventListener('click', () => void copySetup(true));
        const form = card.querySelector<HTMLFormElement>('#setup-form')!;
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void action(async () => {
            if (!setup) return;
            if (pendingSetup) { await submitSetupCode(form, card, version); return; }
            const currentSetup = setup;
            const device = { deviceName: formValue(form, 'deviceName'), remember: new FormData(form).has('remember') };
            banner('请按照系统提示保存通行密钥；完成后再输入动态码。');
            const response = await startRegistration({ optionsJSON: currentSetup.options });
            if (!rootIsCurrent(version) || setup !== currentSetup) return;
            pendingSetup = { flow: currentSetup, response, device };
            form.innerHTML = '<h2>03 · 输入最新六位动态码</h2><p class="admin-copy">系统保存已完成。现在打开刚扫码添加的验证器账户，填写当前六位数字；无需再次扫码。</p><label class="admin-field">最新动态码<input class="admin-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required autofocus></label><div class="admin-actions"><button class="primary" type="submit">验证动态码并完成绑定</button><button class="text-button" id="restart-setup-proof" type="button">重新选择通行密钥</button></div>';
            form.querySelector('#restart-setup-proof')!.addEventListener('click', () => {
              if (setupSubmitting) return;
              const current = pendingSetup; pendingSetup = null;
              form.innerHTML = `<label class="admin-field">这台设备的名称<input name="deviceName" maxlength="80" value="${e(current?.device.deviceName ?? '我的第一台设备')}" autocomplete="off" required></label><label class="admin-checkbox"><input type="checkbox" name="remember" ${current?.device.remember === false ? '' : 'checked'}>记住这台设备，最长 6 个月</label><p class="admin-help">完成系统保存后再填写最新动态码。</p><button class="primary" type="submit">保存通行密钥 <span aria-hidden="true">↗</span></button>`;
              banner('可以重新完成系统验证，无需重新扫码。');
            });
            banner('请填写最新动态码，完成服务端绑定确认。');
            form.querySelector<HTMLInputElement>('[name="code"]')!.focus();
          }, form.querySelector<HTMLButtonElement>('[type="submit"]')!);
        });
      }, startForm.querySelector<HTMLButtonElement>('button')!);
    });
  }
  async function submitSetupCode(form: HTMLFormElement, card: HTMLElement, version: number) {
    const current = pendingSetup;
    if (!current || setupSubmitting) return;
    setupSubmitting = true;
    try {
      try {
        await request('/admin/setup/verify', { flowId: current.flow.flowId, response: current.response, code: formValue(form, 'code'), ...current.device });
      } catch (error) {
        if (!rootIsCurrent(version) || error instanceof StaleRequestError) return;
        const input = form.querySelector<HTMLInputElement>('[name="code"]');
        if (input) input.value = '';
        if (error instanceof ApiError && error.code === 'TOTP_INVALID') {
          reportError(error); input?.focus(); return;
        }
        pendingSetup = null;
        if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'SETUP_UNAVAILABLE') {
          try {
            const status = await request<{ configured: boolean }>('/admin/status');
            if (!rootIsCurrent(version)) return;
            if (status.configured) { setup = null; setupToken = ''; showSavedSetupConfirmation(error); return; }
          } catch (confirmation) {
            if (!rootIsCurrent(version) || confirmation instanceof StaleRequestError) return;
            showSavedSetupConfirmation(error, false); return;
          }
        }
        if (!rootIsCurrent(version)) return;
        reportError(error);
        form.innerHTML = '<p class="admin-copy">这次验证未完成。请先查看上方失败阶段；重新开始时会生成新的二维码，应使用新二维码绑定验证器。</p><button class="secondary" id="restart-setup" type="button">重新开始绑定</button>';
        form.querySelector('#restart-setup')!.addEventListener('click', () => { setup = null; showSetup(); });
        return;
      }
      if (!rootIsCurrent(version)) return;
      pendingSetup = null; setup = null; setupToken = ''; form.reset(); card.replaceChildren();
      const confirming = document.createElement('p'); confirming.className = 'admin-copy'; confirming.textContent = '正在确认管理会话…'; card.append(confirming);
      history.replaceState(null, '', '#/admin');
      try { const account = await request<Me>('/admin/me'); if (rootIsCurrent(version)) { me = account; showSetupSuccess(); } }
      catch (error) { if (rootIsCurrent(version) && !(error instanceof StaleRequestError)) { me = null; showSavedSetupConfirmation(error); } }
    } finally { setupSubmitting = false; }
  }
  function showSetupSuccess() {
    if (!alive || !me) return;
    const sessionId = me.session.id;
    const version = shell('<section class="admin-auth"><p class="eyebrow">SETUP COMPLETE</p><h1>设置已完成。</h1><p class="admin-copy">确认后即可进入管理后台。</p><div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div></section>');
    setupSuccessVisible = true;
    const dialog = document.createElement('dialog'); currentDialog = dialog;
    dialog.className = 'admin-dialog admin-setup-success';
    dialog.setAttribute('aria-labelledby', 'setup-success-title');
    dialog.setAttribute('aria-describedby', 'setup-success-copy');
    dialog.innerHTML = '<div class="admin-setup-success-mark" aria-hidden="true">✓</div><h2 id="setup-success-title">绑定成功</h2><p class="admin-copy" id="setup-success-copy">通行密钥和身份验证器已绑定，可以进入后台管理邀请和登录设备。</p><p class="admin-help">建议在另一台常用设备上再添加一把通行密钥。</p><div class="admin-actions admin-dialog-actions"><button class="primary" type="button" autofocus>进入后台</button></div>';
    dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      const current = currentDialog === dialog;
      if (current) { currentDialog = null; setupSuccessVisible = false; }
      dialog.remove();
      if (current && rootIsCurrent(version) && me?.session.id === sessionId) showDashboard();
    }, { once: true });
    root.append(dialog); dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button')!.focus();
  }
  function showSavedSetupConfirmation(error: unknown, confirmed = true) {
    pendingSetup = null;
    const copy = confirmed ? '后台已完成绑定，暂时未能确认登录状态。无需再次扫码，请重新连接或使用已有通行密钥登录。' : '请求结果暂时未能确认，请先重新连接检查状态。暂时不要重新扫码绑定。';
    const version = shell(`<section class="admin-auth"><p class="eyebrow">CONFIRM YOUR SESSION</p><h1>请重新确认连接。</h1><p class="admin-copy">${copy}</p><div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div><button class="secondary" id="confirm-saved-setup" type="button">重新连接后台</button></section>`);
    reportError(error);
    const button = root.querySelector<HTMLButtonElement>('#confirm-saved-setup')!;
    button.addEventListener('click', () => void action(async () => {
      try {
        if (!confirmed) {
          const status = await request<{ configured: boolean }>('/admin/status');
          if (!rootIsCurrent(version)) return;
          if (!status.configured) { setup = null; showSetup(); banner('尚未完成后台绑定，请重新开始并使用新生成的二维码。', true); return; }
          confirmed = true; setup = null; setupToken = '';
        }
        const account = await request<Me>('/admin/me');
        if (rootIsCurrent(version)) { me = account; showSetupSuccess(); }
      } catch (failure) {
        if (!rootIsCurrent(version) || failure instanceof StaleRequestError) return;
        if (failure instanceof ApiError && failure.status === 401 && confirmed) {
          clearPrivate(); showLogin('后台已完成绑定，请使用已有通行密钥登录。');
        } else throw failure;
      }
    }, button));
  }
  async function copySetup(uri: boolean) {
    if (!setup) return;
    const currentSetup = setup;
    const version = revision;
    const copied = await copyText(uri ? currentSetup.totpUri : currentSetup.totpSecret);
    if (!rootIsCurrent(version) || setup !== currentSetup) return;
    banner(copied ? '已复制。请在身份验证器中添加。' : '浏览器未允许复制，请手动选择设置密钥。', !copied);
  }
  function showDashboard() {
    if (!me || !alive) return;
    const headings = {
      invites: ['邀请链接', '为每位受邀者设置可见内容与有效期。'],
      requests: ['预约申请', '处理待确认的申请，查看已确认的预约。'],
      mail: ['邮箱设置', '配置发信服务，验证接收预约通知和日历附件的邮箱。'],
      location: ['日历地点', '设置预约周历中的城市，按日期调整地点。'],
      calendars: ['日历连接', '同步私人和工作日历的忙闲，设置直接预约。'],
      devices: ['登录设备', '查看和管理能够进入后台的浏览器登录。'],
      passkeys: ['通行密钥', '为常用设备保存登录方式，并管理已经添加的凭据。'],
      password: ['登录密码', '为后台启用一个备用登录方式。'],
    };
    const [title, description] = headings[tab];
    const tabs = Object.entries(headings).map(([key, [label]]) => `<button class="admin-tab" data-tab="${key}" role="tab" aria-selected="${tab === key}">${label}</button>`).join('');
    const version = shell(`<section class="admin-intro"><div><p class="eyebrow">PRIVATE APPOINTMENTS</p><h1>${title}</h1><p>${description}</p></div><span class="admin-pill">已验证的管理会话</span></section><nav class="admin-tabs" aria-label="后台管理">${tabs}</nav><div id="admin-message" class="admin-banner" role="status" aria-live="polite"></div><div id="admin-content"><p class="admin-loading">正在读取…</p></div>`, true);
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab as typeof tab; showDashboard(); }));
    void action(async () => {
      if (tab === 'invites') {
        const data = await request<InviteList>('/admin/invites');
        if (rootIsCurrent(version)) { observeInviteTime(data.now); showInvites(data.invites); }
      } else if (tab === 'devices') {
        const data = await request<{ devices: Session[] }>('/admin/devices');
        if (rootIsCurrent(version)) showDevices(data.devices);
      } else if (tab === 'passkeys') {
        const data = await request<{ passkeys: Passkey[] }>('/admin/passkeys');
        if (rootIsCurrent(version)) showPasskeys(data.passkeys);
      } else if (tab === 'password') {
        const data = await request<PasswordSettings>('/admin/password');
        if (rootIsCurrent(version)) showPasswordSettings(data);
      } else {
        await showBookingPanel(tab, version);
      }
    });
  }
  async function showBookingPanel(panel: 'requests' | 'mail' | 'location' | 'calendars', version: number) {
    const content = root.querySelector<HTMLElement>('#admin-content');
    if (!content) return;
    const isCurrent = () => rootIsCurrent(version) && me !== null;
    let busy = false;
    const run: PanelActions['run'] = async (operation, button) => {
      if (busy || !isCurrent()) return;
      busy = true;
      try { await action(operation, button); }
      finally { busy = false; }
    };
    if (panel === 'requests') {
      const filter = requestFilter;
      const reload = async (message?: string) => {
        const { requests } = await request<{ requests: BookingView[] }>(`/admin/requests?status=${filter}`);
        if (!isCurrent()) return;
        renderBookingInbox(content, requests, filter, actions, next => { requestFilter = next; showDashboard(); });
        if (message) banner(message);
      };
      const actions: PanelActions = { request, run, banner, isCurrent, reload };
      await reload();
    } else if (panel === 'mail') {
      const invites = request<InviteList>('/admin/invites').then(data => ({ ...data, observedAt: performance.now() }));
      const reload = async (message?: string) => {
        const [settings, list] = await Promise.all([request<MailSettings>('/admin/mail'), invites]);
        if (!isCurrent()) return;
        const overrides = new Set(settings.overrides.map(item => item.inviteId));
        const now = Number.isFinite(list.now) ? list.now + performance.now() - list.observedAt : Date.now();
        const available = list.invites.flatMap(invite => {
          const status = isRevoked(invite) ? '已撤销' : epoch(invite.expiresAt) <= now ? '已过期' : '';
          return !status || overrides.has(invite.id) ? [{ id: invite.id, label: status ? `${invite.label} · ${status}` : invite.label }] : [];
        });
        renderMailSettings(content, settings, available, actions);
        if (message) banner(message);
      };
      const actions: PanelActions = { request, run, banner, isCurrent, reload };
      await reload();
    } else if (panel === 'calendars') {
      const reload = async (message?: string) => {
        const settings = await request<CalendarConnections>('/admin/calendar-sources');
        if (!isCurrent()) return;
        renderCalendarConnections(content, settings, actions);
        if (message) banner(message);
      };
      const actions: PanelActions = { request, run, banner, isCurrent, reload };
      const returned = calendarReturn;
      calendarReturn = null;
      if (returned?.has('state') && returned.has('code')) {
        try {
          await request('/admin/calendar-sources/outlook/finish', { state: returned.get('state'), code: returned.get('code') });
          await reload('Microsoft 已授权。请选择要同步的工作日历。');
        } catch (error) {
          if (isCurrent() && !(error instanceof StaleRequestError)) reportError(error);
          await reload();
        }
      } else {
        await reload();
        if (returned?.has('cancelled') && isCurrent()) banner('Microsoft 授权未完成，可以重新开始。', true);
      }
    } else {
      const reload = async (message?: string) => {
        const settings = await request<CalendarLocationSettings>('/admin/calendar-location');
        if (!isCurrent()) return;
        renderCalendarLocation(content, settings, actions, inviteNow());
        if (message) banner(message);
      };
      const actions: PanelActions = { request, run, banner, isCurrent, reload };
      await reload();
    }
  }
  function observeInviteTime(serverNow: number) {
    const time = Number.isFinite(serverNow) ? serverNow : Date.now();
    const observedAt = performance.now();
    inviteNow = () => time + (performance.now() - observedAt);
  }
  function stopInviteWatch() {
    window.clearTimeout(inviteExpiryTimer);
    inviteExpiryTimer = 0;
    refreshInviteBadges = null;
    displayedInvites.clear();
  }
  async function syncInviteClock() {
    const update = refreshInviteBadges;
    update?.();
    if (!update || syncingInviteClock) return;
    syncingInviteClock = true;
    try {
      const data = await request<InviteList>('/admin/invites');
      if (refreshInviteBadges === update) {
        observeInviteTime(data.now);
        update(data.invites);
      }
    } catch { /* Local expiry tracking remains available while disconnected. */ }
    finally { syncingInviteClock = false; }
  }
  function canShareInvite(id: string) {
    const invite = displayedInvites.get(id);
    if (!invite) return false;
    const { state } = inviteStatus(epoch(invite.expiresAt), isRevoked(invite), inviteNow());
    return state === 'active' || state === 'expiring';
  }
  function showInvites(invites: Invite[], editing?: Invite) {
    const content = root.querySelector<HTMLElement>('#admin-content');
    if (!content) return;
    stopInviteWatch();
    displayedInvites = new Map(invites.map(invite => [invite.id, invite]));
    const version = revision;
    const permissions = editing?.permissions ?? { modules: ['profile', 'calendar', 'contact'], modes: ['request', 'open'] };
    content.innerHTML = `<div class="admin-grid"><section class="admin-card"><div class="admin-section-head"><h2>${editing ? '编辑邀请' : '创建专属链接'}</h2>${editing ? '<button class="text-button" id="cancel-edit" type="button">取消</button>' : ''}</div><form id="invite-form"><label class="admin-field">备注名称<input name="label" maxlength="80" value="${e(editing?.label ?? '')}" placeholder="例如：给一位朋友" required><span class="admin-help">仅你可见，不会显示给受邀者。</span></label><label class="admin-field">有效期至 · 当前设备时区<input name="expiresAt" type="datetime-local" value="${e(localDate(editing?.expiresAt ?? inviteNow() + 30 * 86_400_000))}" required></label>${permissionsForm(permissions)}<div class="admin-actions"><button class="primary" type="submit">${editing ? '保存设置' : '创建链接'} <span aria-hidden="true">↗</span></button><button class="secondary" id="preview-draft" type="button">预览当前设置</button></div></form><p class="admin-inline-note">邀请链接仅在创建时提供，请复制保存。之后可复制为新链接。在「邮箱设置」开放预约申请后，勾选「申请时间」的邀请可接收申请。</p></section><section class="admin-card"><div class="admin-section-head"><h2>我的邀请</h2><span class="admin-count">${invites.length} 条</span></div><div id="new-link"></div><div class="admin-list" id="invite-list"></div></section></div>`;
    content.querySelector('#cancel-edit')?.addEventListener('click', () => showInvites([...displayedInvites.values()]));
    const list = content.querySelector<HTMLElement>('#invite-list')!;
    const updateRows: ((now: number) => number | null)[] = [];
    if (!invites.length) list.innerHTML = '<p class="admin-empty">还没有邀请。创建第一条链接，选择对方可以看到的内容。</p>';
    for (const invite of invites) {
      const item = document.createElement('article');
      item.className = 'admin-item';
      item.innerHTML = `<div class="admin-item-head"><h3>${e(invite.label)}</h3><span class="admin-pill" data-invite-state></span></div><p class="admin-item-description">${e(invite.permissions.modules.map(name => moduleNames[name]).filter(Boolean).join(' · ') || '未开放展示模块')}</p><div class="admin-item-meta"><span data-invite-expiry>有效至 ${e(formatTime(invite.expiresAt))}</span><span>打开 ${e(invite.openCount)} 次 · 最近 ${e(formatTime(invite.lastOpenedAt))}</span></div><div class="admin-actions"><button class="secondary" type="button" data-action="edit">编辑 / 延期</button><button class="secondary" type="button" data-action="clone">复制为新链接</button><button class="text-button" type="button" data-action="preview">预览</button>${recentLinks.has(invite.id) ? '<button class="text-button" type="button" data-action="copy">复制链接</button>' : ''}<button class="text-button admin-danger" type="button" data-action="revoke">撤销</button></div>`;
      const edit = item.querySelector<HTMLButtonElement>('[data-action="edit"]')!;
      const copy = item.querySelector<HTMLButtonElement>('[data-action="copy"]');
      const revoke = item.querySelector<HTMLButtonElement>('[data-action="revoke"]')!;
      const badge = item.querySelector<HTMLElement>('[data-invite-state]')!;
      const expiry = item.querySelector<HTMLElement>('[data-invite-expiry]')!;
      let shownExpiry = invite.expiresAt;
      updateRows.push(now => {
        const latest = displayedInvites.get(invite.id) ?? invite;
        const { state, nextAt } = inviteStatus(epoch(latest.expiresAt), isRevoked(latest), now);
        if (badge.textContent !== inviteStateLabels[state]) badge.textContent = inviteStateLabels[state];
        badge.classList.toggle('muted', state === 'revoked' || state === 'expired');
        badge.classList.toggle('invite-expiring', state === 'expiring');
        edit.disabled = state === 'revoked';
        revoke.hidden = state === 'revoked';
        if (copy) {
          copy.disabled = state === 'revoked' || state === 'expired';
          copy.title = state === 'expired' ? '邀请已过期，请延期后再复制' : state === 'revoked' ? '邀请已撤销' : '';
        }
        if (shownExpiry !== latest.expiresAt) {
          shownExpiry = latest.expiresAt;
          expiry.textContent = `有效至 ${formatTime(shownExpiry)}`;
        }
        return nextAt;
      });
      edit.addEventListener('click', () => {
        showInvites([...displayedInvites.values()], displayedInvites.get(invite.id));
        content.querySelector<HTMLInputElement>('[name="label"]')?.focus();
      });
      item.querySelector('[data-action="clone"]')!.addEventListener('click', (event) => void action(async () => { const result = await request<{ invite: Invite; url: string }>(`/admin/invites/${encodeURIComponent(invite.id)}/clone`, {}); await refreshInvites(result, version); }, event.currentTarget as HTMLButtonElement));
      item.querySelector('[data-action="preview"]')!.addEventListener('click', (event) => void action(() => createPreview({ inviteId: invite.id }), event.currentTarget as HTMLButtonElement));
      copy?.addEventListener('click', () => void copyInvite(invite.id));
      revoke.addEventListener('click', (event) => {
        if (!confirm('撤销后，对方将无法再使用这条邀请链接。确定撤销吗？')) return;
        void action(async () => { await request(`/admin/invites/${encodeURIComponent(invite.id)}`, {}, 'DELETE'); recentLinks.delete(invite.id); await refreshInvites(undefined, version); if (rootIsCurrent(version)) banner('邀请已撤销，立即生效。'); }, event.currentTarget as HTMLButtonElement);
      });
      list.append(item);
    }
    const fresh = content.querySelector<HTMLElement>('#new-link')!;
    function updateBadges(updates?: Invite[]) {
      window.clearTimeout(inviteExpiryTimer);
      if (!rootIsCurrent(version) || !content?.isConnected) return;
      if (updates) for (const invite of updates) {
        if (displayedInvites.has(invite.id)) displayedInvites.set(invite.id, invite);
      }
      const now = inviteNow();
      let nextAt = Infinity;
      for (const update of updateRows) nextAt = Math.min(nextAt, update(now) ?? Infinity);
      if (fresh.dataset.inviteId && !canShareInvite(fresh.dataset.inviteId)) {
        fresh.replaceChildren();
        delete fresh.dataset.inviteId;
      }
      if (Number.isFinite(nextAt)) {
        // Timers cannot be scheduled more than 2^31−1 milliseconds ahead.
        inviteExpiryTimer = window.setTimeout(updateBadges, Math.min(2_147_483_647, Math.max(1, Math.ceil(nextAt - now))));
      }
    }
    refreshInviteBadges = updateBadges;
    updateBadges();
    const form = content.querySelector<HTMLFormElement>('#invite-form')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const expiresAt = new Date(formValue(form, 'expiresAt'));
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= inviteNow()) { banner('请选择未来的有效期。', true); return; }
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
    const data = await request<InviteList>('/admin/invites');
    if (!rootIsCurrent(expectedRevision) || tab !== 'invites' || !me) return;
    observeInviteTime(data.now);
    showInvites(data.invites);
    if (created) showNewLink(created.invite.id, created.url);
  }
  function showNewLink(id: string, url: string) {
    const target = root.querySelector<HTMLElement>('#new-link');
    if (!target || !safeShareUrl(url) || !canShareInvite(id)) return;
    target.dataset.inviteId = id;
    target.innerHTML = '<section class="admin-secret"><h2>专属链接已准备好</h2><p class="admin-copy">请现在复制保存。此链接不会显示在公开首页，也不会再次从服务器取回。</p><input readonly aria-label="新邀请链接"><div class="admin-actions"><button class="secondary" type="button">复制链接</button><a class="text-button" target="_blank" rel="noopener noreferrer">打开链接 ↗</a></div></section>';
    target.querySelector<HTMLInputElement>('input')!.value = url;
    const open = target.querySelector<HTMLAnchorElement>('a')!;
    open.href = url;
    open.addEventListener('click', event => {
      if (canShareInvite(id)) return;
      event.preventDefault();
      refreshInviteBadges?.();
      banner('这条邀请已失效，请延期或复制为新链接。', true);
    });
    target.querySelector('button')!.addEventListener('click', () => void copyInvite(id));
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function safeShareUrl(value: string): boolean {
    try { const url = new URL(value); return url.origin === location.origin && /^#\/i\/[A-Za-z0-9_-]+$/.test(url.hash); } catch { return false; }
  }
  async function copyInvite(id: string) {
    const url = recentLinks.get(id);
    if (!url || !safeShareUrl(url) || !canShareInvite(id)) {
      refreshInviteBadges?.();
      banner('这条邀请已失效，请延期或复制为新链接。', true);
      return;
    }
    await showCopyResult(url);
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
      item.innerHTML = `<div class="admin-item-head"><h3>${e(device.label)}</h3>${device.current ? '<span class="admin-pill">当前设备</span>' : ''}</div><p class="admin-item-description">${e(device.os)} · ${e(device.browser)} · ${device.method === 'password' ? '密码登录' : '通行密钥登录'}</p><div class="admin-item-meta"><span>首次登录 ${e(formatTime(device.createdAt))}</span><span>最近使用 ${e(formatTime(device.lastSeenAt))}</span><span>有效至 ${e(formatTime(device.expiresAt))}</span></div><form class="admin-device-rename"><label class="admin-field">设备名称<input name="label" maxlength="80" value="${e(device.label)}" required></label><div class="admin-actions"><button class="secondary" type="submit">保存名称</button><button class="text-button admin-danger" type="button">${device.current ? '退出当前登录' : '移除登录'}</button></div></form>`;
      const form = item.querySelector<HTMLFormElement>('form')!;
      form.addEventListener('submit', (event) => { event.preventDefault(); void action(async () => { await request(`/admin/devices/${encodeURIComponent(device.id)}`, { label: formValue(form, 'label') }, 'PATCH'); const data = await request<{ devices: Session[] }>('/admin/devices'); if (rootIsCurrent(version) && me && tab === 'devices') { showDevices(data.devices); banner('设备名称已保存。'); } }, form.querySelector<HTMLButtonElement>('[type="submit"]')!); });
      item.querySelector<HTMLButtonElement>('[type="button"]')!.addEventListener('click', (event) => {
        if (!confirm(device.current ? '确定退出当前设备吗？' : '移除后，这个浏览器需要重新验证才能登录。确定移除吗？')) return;
        void action(async () => { await request(`/admin/devices/${encodeURIComponent(device.id)}`, {}, 'DELETE'); if (device.current) { clearPrivate(); await initialize('已退出这台设备。'); } else if (rootIsCurrent(version)) { showDashboard(); } }, event.currentTarget as HTMLButtonElement);
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
  function showPasswordSettings(settings: PasswordSettings) {
    const content = root.querySelector<HTMLElement>('#admin-content');
    if (!content || !me) return;
    const version = revision;
    passwordEnabled = settings.enabled;
    const description = settings.enabled
      ? `设置于 ${e(formatTime(settings.updatedAt))}。更换或停用密码会退出使用旧密码登录的设备。`
      : '系统会生成一个随机密码。请将它保存到密码管理器，以便在登录页使用。';
    content.innerHTML = `
      <section class="admin-card">
        <div class="admin-section-head">
          <h2>密码登录</h2>
          <span class="admin-pill${settings.enabled ? '' : ' muted'}">${settings.enabled ? '已启用' : '未启用'}</span>
        </div>
        <p class="admin-copy">${description}</p>
        ${me.session.method === 'password'
          ? '<p class="admin-copy">请退出当前登录，然后使用通行密钥登录以管理密码。</p>'
          : `<div class="admin-actions">
              <button class="secondary" type="button" id="generate-password">${settings.enabled ? '更换密码' : '生成登录密码'}</button>
              ${settings.enabled ? '<button class="text-button admin-danger" type="button" id="disable-password">停用密码登录</button>' : ''}
            </div>`}
      </section>`;
    const generate = content.querySelector<HTMLButtonElement>('#generate-password');
    const disable = content.querySelector<HTMLButtonElement>('#disable-password');
    let changing = false;
    async function changePassword(button: HTMLButtonElement, disabling: boolean) {
      if (changing) return;
      if (settings.enabled && !confirm(disabling
        ? '停用密码登录后，已使用密码登录的设备将退出。确定停用吗？'
        : '更换后旧密码将失效，已使用旧密码登录的设备将退出。确定更换吗？')) return;
      changing = true;
      const other = disabling ? generate : disable;
      if (other) other.disabled = true;
      try {
        await action(async () => {
          try {
            if (disabling) {
              await request('/admin/password', { revision: settings.revision }, 'DELETE');
              passwordEnabled = false;
              if (rootIsCurrent(version)) {
                showPasswordSettings({ enabled: false, revision: null, updatedAt: null });
                banner('密码登录已停用。');
              }
            } else {
              const result = await request<GeneratedPassword>('/admin/password', { revision: settings.revision });
              if (typeof result?.password !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.password)) {
                throw new ApiError(503, 'INVALID_PASSWORD_RESULT', 'PASSWORD_SETTINGS');
              }
              passwordEnabled = true;
              if (rootIsCurrent(version)) {
                showPasswordSettings({ enabled: true, revision: result.revision, updatedAt: result.updatedAt });
                showGeneratedPassword(result.password);
              }
            }
          } catch (error) {
            if (error instanceof ApiError && (error.status === 0 || error.status >= 500) && rootIsCurrent(version)) {
              reportError(error, '暂时无法确认密码设置结果。请重新打开「登录密码」，查看状态后再操作。');
              return;
            }
            throw error;
          }
        }, button);
      } finally {
        changing = false;
        if (other?.isConnected) other.disabled = false;
      }
    }
    generate?.addEventListener('click', () => void changePassword(generate, false));
    disable?.addEventListener('click', () => void changePassword(disable, true));
  }
  function showGeneratedPassword(password: string) {
    const dialog = document.createElement('dialog');
    dialog.className = 'admin-dialog';
    dialog.setAttribute('aria-labelledby', 'generated-password-title');
    dialog.innerHTML = `
      <h2 id="generated-password-title">新密码已生成</h2>
      <p class="admin-copy">密码只显示这一次。请将它保存到密码管理器，再关闭此窗口。</p>
      <label class="admin-field">登录密码<input class="admin-password-secret" readonly autocomplete="off" spellcheck="false"></label>
      <div class="admin-copy" role="status" id="password-copy-result"></div>
      <div class="admin-actions admin-dialog-actions">
        <button class="text-button" type="button" id="close-generated-password">关闭</button>
        <button class="primary" type="button" id="copy-generated-password" autofocus>复制密码</button>
      </div>`;
    const field = dialog.querySelector<HTMLInputElement>('input')!;
    const result = dialog.querySelector<HTMLElement>('#password-copy-result')!;
    field.value = password;
    dialog.querySelector('#copy-generated-password')!.addEventListener('click', async () => {
      const copied = await copyText(field.value);
      if (currentDialog !== dialog || !dialog.open) return;
      result.textContent = copied ? '密码已复制。' : '自动复制未成功，请手动复制上方密码。';
      if (!copied) { field.focus(); field.select(); }
    });
    const close = () => { field.value = ''; dialog.close(); };
    dialog.querySelector('#close-generated-password')!.addEventListener('click', close);
    window.addEventListener('pagehide', close, { once: true });
    dialog.addEventListener('close', () => {
      window.removeEventListener('pagehide', close);
      field.value = '';
      dialog.remove();
      if (currentDialog === dialog) currentDialog = null;
    }, { once: true });
    currentDialog = dialog;
    root.append(dialog);
    dialog.showModal();
  }
  async function showReauth(): Promise<void> {
    if (!alive || !me || currentDialog) return;
    const sessionId = me.session.id;
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog'); currentDialog = dialog; dialog.className = 'admin-dialog';
      dialog.innerHTML = '<h2>再确认一次，是你本人。</h2><p class="admin-copy">这项操作需要系统通行密钥验证。验证完成后可继续刚才的操作。</p><div class="admin-copy" role="status" id="reauth-message"></div><form id="reauth-step"><div class="admin-actions"><button class="text-button" id="cancel-reauth" type="button">取消</button><button class="primary" type="submit">使用通行密钥确认身份</button></div></form>';
      const isCurrent = () => alive && currentDialog === dialog && dialog.isConnected && me?.session.id === sessionId;
      let busy = false;
      dialog.querySelector('#cancel-reauth')!.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => {
        const current = currentDialog === dialog;
        dialog.remove();
        if (current) { currentDialog = null; WebAuthnAbortService.cancelCeremony(); }
        resolve();
      }, { once: true });
      const form = dialog.querySelector<HTMLFormElement>('form')!;
      form.addEventListener('submit', event => {
        event.preventDefault(); if (busy || !isCurrent()) return; busy = true;
        const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!; button.disabled = true;
        dialog.querySelector('#reauth-message')!.textContent = '请完成系统弹出的通行密钥验证。';
        void (async () => {
          try {
            const flow = await request<Options<AuthenticationOptions>>('/admin/reauth/options', {});
            if (!isCurrent()) return;
            const response = await startAuthentication({ optionsJSON: flow.options });
            if (!isCurrent()) return;
            await request('/admin/reauth/verify', { flowId: flow.flowId, response });
            if (!isCurrent()) return;
            dialog.close(); banner('身份验证完成，请再次点击刚才的操作。');
          } catch (error) {
            if (isCurrent() && !(error instanceof StaleRequestError)) reportError(error, undefined, dialog.querySelector<HTMLElement>('#reauth-message'));
          } finally { busy = false; if (button.isConnected) button.disabled = false; }
        })();
      });
      root.append(dialog); dialog.showModal();
    });
  }
  async function initialize(loginMessage = '') {
    const version = shell('<p class="admin-loading">正在确认管理入口…</p>');
    try {
      const status = await request<{ configured: boolean; passwordEnabled?: boolean }>('/admin/status');
      if (!rootIsCurrent(version)) return;
      passwordEnabled = status.passwordEnabled === true;
      if (!status.configured) { showSetup(); return; }
      if (setupToken) { setupToken = ''; history.replaceState(null, '', '#/admin'); }
      try { me = await request<Me>('/admin/me'); if (rootIsCurrent(version)) showDashboard(); }
      catch (error) { if (rootIsCurrent(version)) { if (error instanceof ApiError && error.status === 401) showLogin(loginMessage); else showUnavailable(error); } }
    } catch (error) { if (rootIsCurrent(version)) showUnavailable(error); }
  }
  function showUnavailable(error: unknown) {
    shell('<section class="admin-auth"><p class="eyebrow">PRIVATE DESK</p><h1>暂时无法连接后台。</h1><div id="admin-message" class="admin-banner" role="status"></div><button class="secondary" id="retry-admin" type="button">重新连接</button></section>');
    reportError(error);
    root.querySelector('#retry-admin')!.addEventListener('click', () => void initialize());
  }
  let checkingSession = false;
  async function checkSession() {
    if (!alive || !me || checkingSession || setupSuccessVisible || document.hidden) return;
    checkingSession = true;
    const version = revision;
    const sessionId = me.session.id;
    try { const current = await request<Me>('/admin/me'); if (rootIsCurrent(version) && me?.session.id === sessionId) me = current; }
    catch (error) { if (rootIsCurrent(version) && me && !(error instanceof StaleRequestError)) banner('暂时无法确认登录状态，请检查网络。', true); }
    finally { checkingSession = false; }
  }
  const visibility = () => {
    if (!document.hidden) { void syncInviteClock(); void checkSession(); }
  };
  const clearSettingsSecrets = () => {
    root.querySelectorAll<HTMLInputElement>('[data-mail-sender] [name="apiKey"], [data-calendar-secret]').forEach(input => { input.value = ''; });
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pageshow', visibility);
  window.addEventListener('pagehide', clearSettingsSecrets);
  const interval = window.setInterval(() => void checkSession(), 45000);
  void initialize();
  return () => {
    clearSettingsSecrets();
    alive = false; controller.abort(); clearPrivate(); setupToken = '';
    window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', visibility);
    window.removeEventListener('pagehide', clearSettingsSecrets);
    root.replaceChildren();
  };
}
