import type { PanelActions } from './admin-m2';
import { escapeHtml as e } from './ui';

export interface ProfileSettings {
  displayName: string; profile: string; tracks: string; investments: string; contact: string; updatedAt: number;
}

const fields = [
  { name: 'profile', label: '个人介绍', hint: '受邀者拥有「个人介绍」权限时可见，同时显示上面的称呼。', rows: 6 },
  { name: 'tracks', label: '关注方向', hint: '拥有「关注方向」权限时可见。', rows: 5 },
  { name: 'investments', label: '投资经历', hint: '拥有「投资经历」权限时可见。只写愿意向这位受邀者公开的内容。', rows: 6 },
  { name: 'contact', label: '联系方式', hint: '拥有「联系方式」权限时可见。按纯文字显示，不会生成链接。', rows: 3 },
] as const;

export function renderProfile(content: HTMLElement, settings: ProfileSettings, actions: PanelActions) {
  content.innerHTML = `<section class="admin-card">
    <h2>个人展示内容</h2>
    <p class="admin-copy">这里的文字只会在受邀者打开邀请链接后，按该邀请勾选的「可见内容」显示，首页和静态文件里没有这些内容。使用纯文字，换行会保留。保存后立即生效，可用邀请的「预览」查看效果。</p>
    <form method="post" data-profile>
      <label class="admin-field">称呼<input name="displayName" maxlength="40" value="${e(settings.displayName)}" placeholder="例如：Patrick" autocomplete="off"><span class="admin-help">显示为「某某的预约空间」，仅随「个人介绍」权限下发。留空则不显示。</span></label>
      ${fields.map(field => `<label class="admin-field">${field.label}<textarea name="${field.name}" rows="${field.rows}" maxlength="2000" data-count>${e(settings[field.name])}</textarea><span class="admin-help">${field.hint} <span data-counter="${field.name}"></span></span></label>`).join('')}
      <div class="admin-actions"><button class="primary" type="submit">保存</button></div>
    </form>
  </section>`;
  const form = content.querySelector<HTMLFormElement>('[data-profile]')!;
  for (const area of form.querySelectorAll<HTMLTextAreaElement>('textarea')) {
    const counter = form.querySelector<HTMLElement>(`[data-counter="${area.name}"]`)!;
    const update = () => { counter.textContent = `${[...area.value].length} / 2000`; };
    area.addEventListener('input', update);
    update();
  }
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!actions.isCurrent()) return;
    const data = new FormData(form);
    const body = Object.fromEntries(['displayName', ...fields.map(field => field.name)].map(name => [name, String(data.get(name) ?? '')]));
    void actions.run(async () => {
      await actions.request('/admin/profile', body, 'PATCH');
      if (actions.isCurrent()) await actions.reload('个人展示内容已保存。');
    }, button);
  });
}
