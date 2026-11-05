import './styles.css';
import { carriers, connections, exportRecords, loadRecords, probe, probeLabel, saveRecords } from './connectivity';
import type { CheckRecord, ProbeResult } from './connectivity';

const root = document.querySelector<HTMLDivElement>('#app')!;
const lock = '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect x="10" y="17" width="20" height="17" rx="4"/><path d="M14 17v-5a6 6 0 0 1 12 0v5M20 24v3"/></svg>';
let disposeRoute: (() => void) | undefined;
let routeVersion = 0;

function renderGate(unavailable: boolean) {
  root.innerHTML = `
    <main class="gate">
      <div class="gate-mark">${lock}</div>
      <p class="eyebrow">BY INVITATION</p>
      <h1>${unavailable ? '链接暂时无法使用' : '仅限受邀访问'}</h1>
      <p class="gate-copy">${unavailable ? '请向邀请人获取可用的邀请链接。' : '请通过邀请人发送的专属链接进入。'}</p>
      <span class="gate-rule" aria-hidden="true"></span>
      <p class="gate-note">PRIVATE APPOINTMENTS</p>
    </main>`;
}

function renderCheck() {
  let records = loadRecords();
  root.innerHTML = `
    <main class="check-page">
      <header class="check-header">
        <a class="wordmark" href="#/">受邀预约<span aria-hidden="true">↗</span></a>
        <span class="stage">M0 · 连通性验证</span>
      </header>
      <section class="check-intro">
        <p class="eyebrow">CONNECTION CHECK</p>
        <h1>先确认，<br>每一次连接。</h1>
        <p>分别检查页面和预约服务。请切换手机网络后再测试一次，确认受邀者能够顺利访问。</p>
      </section>
      <section class="check-card" aria-labelledby="check-title">
        <div class="section-heading"><span class="section-number">01</span><h2 id="check-title">测试当前网络</h2></div>
        <form id="check-form">
          <div class="fields">
            <label>运营商<select id="carrier">${carriers.map((value) => `<option>${value}</option>`).join('')}</select></label>
            <label>连接方式<select id="connection">${connections.map((value) => `<option>${value}</option>`).join('')}</select></label>
          </div>
          <button class="primary" id="run-check" type="submit">开始检测 <span aria-hidden="true">↗</span></button>
        </form>
        <div class="results" aria-live="polite" aria-atomic="true">
          <div class="result"><span class="result-label">页面资源</span><strong id="frontend-result">等待检测</strong></div>
          <div class="result"><span class="result-label">预约 API</span><strong id="api-result">${__API_BASE_URL__ ? '等待检测' : '待配置'}</strong></div>
        </div>
        <p class="notice" id="check-message">${__API_BASE_URL__ ? '请选择真实网络。系统不会自动识别运营商。' : 'API 尚未配置，目前只检测页面资源。结果不计入完整连通性验收。'}</p>
      </section>
      <section class="check-card" aria-labelledby="records-title">
        <div class="section-heading"><span class="section-number">02</span><h2 id="records-title">本机测试记录</h2></div>
        <p class="section-description">建议覆盖电信、联通、移动的移动网络与 Wi-Fi。记录仅保存在当前浏览器，导出后可汇总其他设备的结果。</p>
        <p id="coverage" class="coverage"></p>
        <div id="records"></div>
        <div class="record-actions"><button class="secondary" id="export" type="button">下载测试记录 ↓</button><button class="text-button" id="clear" type="button">清空本机记录</button></div>
      </section>
      <footer class="check-footer">测试只请求公开的连通性接口，不读取日历、个人资料或邀请链接。<br>测试记录含时间、网络类型和连接结果。本站不记录 IP 明细。</footer>
    </main>`;

  const recordsView = document.querySelector<HTMLDivElement>('#records')!;
  const download = document.querySelector<HTMLButtonElement>('#export')!;
  const clear = document.querySelector<HTMLButtonElement>('#clear')!;
  const message = document.querySelector<HTMLParagraphElement>('#check-message')!;
  const submit = document.querySelector<HTMLButtonElement>('#run-check')!;

  function updateRecords() {
    download.disabled = records.length === 0;
    clear.disabled = records.length === 0;
    const passed = new Set(records.filter((record) => record.frontend.ok && record.api.ok && record.carrier !== '其他').map((record) => `${record.carrier}-${record.connection}`));
    document.querySelector('#coverage')!.textContent = `三家运营商的六种组合，已有 ${passed.size} / 6 项通过`;
    recordsView.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-records';
      empty.textContent = '还没有记录。完成一次检测后，结果会显示在这里。';
      recordsView.append(empty);
      return;
    }
    for (const record of [...records].reverse()) {
      const row = document.createElement('article');
      row.className = 'record';
      const name = document.createElement('strong');
      name.textContent = `${record.carrier} · ${record.connection}`;
      const time = document.createElement('time');
      time.dateTime = record.checkedAt;
      time.textContent = new Date(record.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const state = document.createElement('span');
      state.className = record.frontend.ok && record.api.ok ? 'record-state passed' : record.frontend.ok && record.api.unconfigured ? 'record-state' : 'record-state failed';
      state.textContent = `页面${probeLabel(record.frontend)} · API ${probeLabel(record.api)}`;
      row.append(name, time, state);
      recordsView.append(row);
    }
  }

  function setResult(id: string, result: ProbeResult) {
    const element = document.querySelector<HTMLElement>(id)!;
    element.textContent = result.unconfigured ? '待配置' : result.ok ? `✓ 连接正常 · ${result.milliseconds} ms` : '× 连接失败';
    element.className = result.unconfigured ? '' : result.ok ? 'passed' : 'failed';
  }

  document.querySelector('#check-form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const carrier = document.querySelector<HTMLSelectElement>('#carrier')!.value;
    const connection = document.querySelector<HTMLSelectElement>('#connection')!.value;
    submit.disabled = true;
    submit.textContent = '正在检测…';
    for (const id of ['#frontend-result', '#api-result']) {
      const result = document.querySelector<HTMLElement>(id)!;
      result.textContent = id === '#api-result' && !__API_BASE_URL__ ? '待配置' : '正在连接…';
      result.className = '';
    }
    message.textContent = __API_BASE_URL__ ? '正在分别验证两个服务，请稍候。' : '正在检测页面资源，API 尚未配置。';
    const [frontend, api] = await Promise.all([
      probe(new URL('./connectivity.json', document.baseURI).href, 'invite-web'),
      probe(__API_BASE_URL__ ? `${__API_BASE_URL__}/health` : null, 'invite-api'),
    ]);
    if (!root.contains(submit)) return;
    setResult('#frontend-result', frontend);
    setResult('#api-result', api);
    records = [...records, { checkedAt: new Date().toISOString(), carrier, connection, frontend, api }].slice(-40);
    const saved = saveRecords(records);
    message.textContent = api.unconfigured
      ? `页面资源${frontend.ok ? '检测通过' : '检测失败，请检查网络'}。API 待配置，本次不计入完整连通性验收。`
      : frontend.ok && api.ok ? '两项均已通过。可以切换下一种网络继续测试。' : '检测未全部通过。请确认设备网络、API 地址和跨域配置，然后重试。';
    if (!saved) message.textContent += ' 浏览器未允许保存记录，请立即下载本次结果。';
    submit.disabled = false;
    submit.textContent = '再次检测 ↗';
    updateRecords();
  });

  download.addEventListener('click', () => exportRecords(records));
  clear.addEventListener('click', () => {
    records = [];
    message.textContent = saveRecords(records) ? '已清空当前浏览器的测试记录。' : '当前页面记录已清空，浏览器未允许更新存储。';
    updateRecords();
  });
  updateRecords();
}

async function route() {
  disposeRoute?.();
  disposeRoute = undefined;
  const version = ++routeVersion;
  const hash = location.hash;
  try {
  if (hash === '#/check') renderCheck();
  else if (hash === '#/admin' || hash.startsWith('#/admin/')) {
    renderGate(false);
    const { renderAdmin } = await import('./admin');
    if (version === routeVersion) disposeRoute = renderAdmin(root);
  } else if (hash.startsWith('#/i/')) {
    renderGate(false);
    const { renderInvitation } = await import('./invitation');
    if (version === routeVersion) disposeRoute = renderInvitation(root, hash.slice(4));
  } else renderGate(Boolean(hash && hash !== '#/' && hash !== '#'));
  } catch {
    if (version === routeVersion) renderGate(true);
  }
}

window.addEventListener('hashchange', () => { void route(); });
void route();
