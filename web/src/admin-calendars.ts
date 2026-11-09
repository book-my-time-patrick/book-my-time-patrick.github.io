import type { PanelActions } from './admin-m2';
import { escapeHtml as e, formatTime } from './ui';

type CalendarOption = { id: string; name: string };
type Source = {
  provider: 'icloud' | 'outlook';
  connected: boolean;
  ready: boolean;
  syncedAt: number | null;
  error: string | null;
  syncing: boolean;
};
export interface CalendarConnections {
  sources: Source[];
  outlookChoices: CalendarOption[];
  directEnabled: boolean;
}

const base = '/admin/calendar-sources';
const errorText: Record<string, string> = {
  CALENDAR_AUTH_REQUIRED: '授权已失效或账户拒绝访问。请重新连接。',
  CALENDAR_UNSUPPORTED: '这个日历未提供可验证的忙闲响应。',
  CALENDAR_RESPONSE_INVALID: '日历服务返回的数据不完整。',
  CALENDAR_LIMIT_EXCEEDED: '日历数据过多，暂时无法完成同步。',
  CALENDAR_UNAVAILABLE: '暂时无法连接日历服务。',
};

export function renderCalendarConnections(content: HTMLElement, state: CalendarConnections, actions: PanelActions) {
  const ready = state.sources.length === 2 && state.sources.every(source => source.ready);
  const options = state.outlookChoices.map(({ id, name }) => `<option value="${e(id)}">${e(name)}</option>`).join('');
  content.innerHTML = `<section class="admin-card">
    <div class="admin-section-head"><h2>同步与直接预约</h2><span class="admin-pill${ready ? '' : ' muted'}">${ready ? '两边都已同步' : '等待同步'}</span></div>
    <p class="admin-copy">每 5 分钟尝试同步。两边都成功且数据在 10 分钟内有效时，受邀者可看到忙闲。直接预约还需要验证送达邮箱，并为相应邀请单独勾选「直接预约」。</p>
    <div class="admin-actions">
      <button type="button" class="primary" data-direct${!ready && !state.directEnabled ? ' disabled' : ''}>${state.directEnabled ? '暂停直接预约' : '允许直接预约'}</button>
      <button type="button" class="secondary" data-calendar-reload>读取最新状态</button>
    </div>
    </section>
    <div class="admin-grid">${state.sources.map(source => `<section class="admin-card">
      <div class="admin-section-head"><h2>${source.provider === 'icloud' ? '私人 iCloud' : '工作 Outlook'}</h2>
        <span class="admin-pill${source.ready ? '' : ' muted'}">${source.syncing ? '同步中' : source.ready ? '已同步' : source.connected ? '同步待恢复' : '待连接'}</span></div>
      ${source.syncedAt ? `<p class="admin-help">最近成功同步 ${e(formatTime(source.syncedAt))}</p>` : ''}
      ${source.error ? `<p class="admin-help">${e(errorText[source.error] ?? errorText.CALENDAR_UNAVAILABLE)}</p>` : ''}
      ${source.connected ? `<div class="admin-actions">
        <button type="button" class="secondary" data-refresh="${source.provider}"${source.syncing ? ' disabled' : ''}>立即同步</button>
        <button type="button" class="text-button admin-danger" data-disconnect="${source.provider}">断开</button>
      </div>` : ''}
      ${source.provider === 'icloud' ? `
        <details${source.connected ? '' : ' open'}><summary>${source.connected ? '重新连接 iCloud' : '连接 iCloud'}</summary>
        <p class="admin-help">在 Apple 账户中生成 App 专用密码，填写后选择要参与计算的私人日历。</p>
        <form method="post" data-icloud>
          <label class="admin-field">Apple 账户邮箱<input name="username" type="email" autocomplete="off" maxlength="254" required></label>
          <label class="admin-field">App 专用密码<input name="appPassword" type="password" autocomplete="new-password" maxlength="128" data-calendar-secret required></label>
          <div data-icloud-choices></div>
          <div class="admin-actions"><button type="submit" class="primary">查找日历</button></div>
        </form></details>` : options ? `
        <form method="post" data-outlook-choice>
          <label class="admin-field">参与计算的工作日历<select name="calendarId" required><option value="">请选择</option>${options}</select></label>
          <div class="admin-actions"><button type="submit" class="primary">保存并同步</button></div>
        </form>` : `
        <details${source.connected ? '' : ' open'}><summary>${source.connected ? '重新授权 Outlook' : '连接 Outlook'}</summary>
        <p class="admin-help">以下配置用于 Microsoft 365。若单位使用自建 Exchange，请先向单位确认可从外网读取忙闲的地址和授权方式。</p>
        <p class="admin-help">在 Microsoft Entra 把此地址添加为 Web 重定向 URI：<code>${e(location.origin)}/api/calendar-oauth/callback</code></p>
        <form method="post" data-outlook>
          <label class="admin-field">账户区域<select name="cloud"><option value="global">Microsoft 365 国际版</option><option value="china">世纪互联</option></select></label>
          <label class="admin-field">目录（租户）ID<input name="tenantId" autocomplete="off" maxlength="80" required></label>
          <label class="admin-field">应用（客户端）ID<input name="clientId" autocomplete="off" maxlength="80" required></label>
          <label class="admin-field">客户端机密值<input name="clientSecret" type="password" autocomplete="new-password" maxlength="512" data-calendar-secret required></label>
          <div class="admin-actions"><button type="submit" class="primary">去 Microsoft 授权</button></div>
        </form></details>`}
    </section>`).join('')}</div>`;

  function button(selector: string, operation: (element: HTMLButtonElement) => Promise<void>) {
    content.querySelectorAll<HTMLButtonElement>(selector).forEach(element => {
      element.addEventListener('click', () => void actions.run(() => operation(element), element));
    });
  }
  function submit(selector: string, operation: (form: HTMLFormElement, data: FormData, element: HTMLButtonElement) => Promise<void>) {
    const form = content.querySelector<HTMLFormElement>(selector);
    const element = form?.querySelector<HTMLButtonElement>('[type="submit"]');
    if (!form || !element) return;
    form.addEventListener('submit', event => {
      event.preventDefault();
      void actions.run(() => operation(form, new FormData(form), element), element);
    });
  }

  button('[data-calendar-reload]', () => actions.reload());
  button('[data-direct]', async () => {
    await actions.request(`${base}/direct`, { enabled: !state.directEnabled });
    if (actions.isCurrent()) await actions.reload(state.directEnabled ? '已暂停直接预约。' : '已允许直接预约，可为指定邀请启用。');
  });
  button('[data-refresh]', async element => {
    await actions.request(`${base}/refresh`, { provider: element.dataset.refresh });
    if (actions.isCurrent()) await actions.reload();
  });
  button('[data-disconnect]', async element => {
    if (!confirm('断开此日历会清除它的同步数据，并暂停直接预约。确定断开吗？')) return;
    await actions.request(`${base}/disconnect`, { provider: element.dataset.disconnect });
    if (actions.isCurrent()) await actions.reload('日历已断开，直接预约已暂停。');
  });
  submit('[data-icloud]', async (form, data, element) => {
    const list = form.querySelector<HTMLElement>('[data-icloud-choices]')!;
    const credentials = { username: data.get('username'), appPassword: data.get('appPassword') };
    const calendarIds = data.getAll('calendarIds');
    if (list.children.length) {
      if (!calendarIds.length || calendarIds.length > 4) { actions.banner('请选择 1 到 4 个私人日历。', true); return; }
      await actions.request(`${base}/icloud/connect`, { ...credentials, calendarIds });
      if (actions.isCurrent()) await actions.reload('iCloud 已连接，并完成首次忙闲同步。');
      return;
    }
    const { calendars } = await actions.request<{ calendars: CalendarOption[] }>(`${base}/icloud/discover`, credentials);
    if (!actions.isCurrent()) return;
    if (!calendars.length) { actions.banner('没有找到可选的 iCloud 日历。', true); return; }
    list.innerHTML = `<fieldset class="admin-fieldset"><legend>选择 1 到 4 个私人日历</legend>${calendars.map(({ id, name }) =>
      `<label class="admin-toggle"><input type="checkbox" name="calendarIds" value="${e(id)}"><span>${e(name)}</span></label>`).join('')}</fieldset>`;
    element.textContent = '保存并同步';
  });
  const appleForm = content.querySelector<HTMLFormElement>('[data-icloud]');
  appleForm?.querySelectorAll<HTMLInputElement>('[name="username"], [name="appPassword"]').forEach(field => {
    field.addEventListener('input', () => {
      appleForm.querySelector('[data-icloud-choices]')?.replaceChildren();
      appleForm.querySelector('[type="submit"]')!.textContent = '查找日历';
    });
  });
  submit('[data-outlook]', async (_form, data) => {
    const { url } = await actions.request<{ url: string }>(`${base}/outlook/start`, Object.fromEntries(data));
    if (!actions.isCurrent()) return;
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
      !['login.microsoftonline.com', 'login.partner.microsoftonline.cn', 'login.chinacloudapi.cn'].includes(target.hostname)) {
      throw new Error('Invalid Microsoft authorization URL');
    }
    location.assign(target.href);
  });
  submit('[data-outlook-choice]', async (_form, data) => {
    await actions.request(`${base}/outlook/select`, { calendarId: data.get('calendarId') });
    if (actions.isCurrent()) await actions.reload('Outlook 已连接，并完成首次忙闲同步。');
  });
}
