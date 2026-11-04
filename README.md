# 受邀预约 · M0

邀请制预约站的最小可运行版本。前端使用 GitHub Pages，API 首选 Cloudflare Workers。普通 Node 服务器可以同时提供前端和 API，作为同域备用部署。

## 当前进度

| 项目 | 当前状态 |
| --- | --- |
| 根路径中性占位、通用预览、搜索屏蔽 | 已实现 |
| 独立 API、精确跨域允许、默认关闭业务接口 | 已实现 |
| 连通性自检、浏览器内记录、CSV 导出 | 已实现 |
| 同一套 API 在 Workers 与 Node 中运行 | 已实现 |
| GitHub Pages 工作流、Workers 配置生成、同域 Docker 配置 | 已提供 |
| 登录可行性 | Argon2id 的两种实现线上反复触发 1102。通行密钥验签、TOTP、组合核心验证各 12/12 通过，完整登录流程待 M1 |
| 真实 Pages、API 部署和大陆三网访问 | 等待仓库、Cloudflare 登录和 API 自有域名 |
| iCloud / Outlook 授权及读取 | 等待后续接入验证 |
| 登录、有效邀请、预约、邮箱与真实日历 | M1–M4 实现 |

M0 所有邀请入口显示统一不可用页。根路径不会请求个人资料或日历。公开的 `#/check` 页面只测试固定连通性信号，不展示个人内容。API 健康检查通过仅说明 API 可用，不代表日历已经同步。

## 本机演示

需要 Node.js 22.12 以上版本和 npm。在项目目录打开终端，复制运行。

```bash
npm ci
npm run dev
```

打开以下地址。

- 首页 `http://127.0.0.1:5173/`，应只看到「仅限受邀访问」。
- 连通性测试 `http://127.0.0.1:5173/#/check`，选择网络后点击「开始检测」。
- 统一不可用页 `http://127.0.0.1:5173/#/i/example-unavailable`。
- API `http://127.0.0.1:8787/api/health`，只返回固定 JSON。

日常开发使用 `127.0.0.1`，不要把前端改成 `localhost` 后又保留原跨域配置。Ctrl+C 结束开发服务。

前端全部字体、脚本、图标随站点提供。没有第三方字体、埋点、验证码或公共资源 CDN。运行时仅请求当前前端和配置好的 API。

## GitHub Pages + Workers 部署

GitHub Pages 只托管静态资源，邀请令牌放在 URL 的 `#` 后。API 校验邀请后才会返回个人数据。CORS 只限制浏览器跨域，实际门禁由 M1 的服务端鉴权负责。当前所有业务接口统一返回 404。

### 1. 准备账号和域名

需要一个你可管理的 GitHub 仓库、Cloudflare 账号，以及一个 DNS 已交给 Cloudflare 管理的自有域名。Pages 入口可以保持 `你的账号.github.io`，自有域名只给 API 使用。

站点仓库为 `https://github.com/book-my-time-patrick/book-my-time-patrick.github.io`，组织与仓库均已创建。正式发布后的分享入口为 `https://book-my-time-patrick.github.io/`，邀请与检查的 hash 路由接在这个地址后。API 的 CORS 前端源填写 `https://book-my-time-patrick.github.io`。API 使用独立的自有域名，与免费分享地址分别配置。

GitHub 免费计划下通常使用公开代码仓库。发布前确认仓库中只有代码，`.env`、凭据、实际邀请和日历文件均不能提交。GitHub Pages 仓库是否私有与网站的邀请门禁是两件事。

年度预算上限为 120 元。Workers、D1 和外部发信通道的免费额度需要分别核验。域名按续费价计算，不按首年促销价推算。免费套餐额度耗尽时应停止服务并提示，不能把失败结果当作空闲。

### 2. 官方登录

在自己的电脑运行。授权页面由 Cloudflare 打开，凭据由工具保管。

```bash
npx wrangler login
npx wrangler whoami
```

不要将 API token、订阅链接或邮箱密码粘贴到聊天或源文件中。后续服务端密钥通过 `wrangler secret put` 设置。前端构建变量全部公开，不能用于存密钥。

### 3. 生成并部署 API 配置

把示例域名替换成你的真实域名。第一个参数只填写前端的源，即协议加域名，不含仓库路径。即使前端在 `/仓库名/` 下，CORS 的源仍是 `https://你的账号.github.io`。

```bash
npm run configure:worker -- https://book-my-time-patrick.github.io https://api.your-domain.com
npm run deploy:api
```

配置保存到忽略提交的 `.local/wrangler.production.jsonc`。默认关闭 `workers.dev` 和预览地址，只绑定指定自有域名。当前不创建数据库、不接入个人日历。D1 在 M1 需要真实持久化时再配置。

打开部署后的 `https://api.your-domain.com/api/health`。成功时应返回以下固定内容。

```json
{"ok":true,"service":"invite-api"}
```

API 与前端资源均设置禁止索引。Workers 关闭请求观测日志，业务代码没有请求记录器。域名服务商和托管平台可能保留各自的基础设施日志，本站应用不写 IP 明细、Authorization 或邀请令牌日志。

### 4. 部署 Pages

1. 将代码提交到 GitHub 仓库的 `main` 分支。
2. 进入仓库 Settings → Pages，将 Source 选为 GitHub Actions。
3. 进入 Settings → Secrets and variables → Actions → Variables，新增 `VITE_API_BASE_URL`，值为 `https://api.your-domain.com/api`。这是公开配置。
4. 在 Actions 中手动运行「验证并部署 GitHub Pages」，或推送到 `main` 触发。
5. 使用工作流输出的 Pages 地址打开首页，再打开同一地址后的 `#/check`。

前端使用相对资源路径，支持用户站根路径和项目站的 `/仓库名/` 路径。无需配置服务器路由或 `404.html`。链接预览的 HTML 标题统一为「受邀预约」，没有姓名、头像或简介。`robots.txt` 禁止抓取，不生成 sitemap。

没有设置该仓库变量时，工作流只执行检查和构建，跳过网站发布。设置非空值后会先检查地址格式，格式无效则阻止发布。API 域名必须使用 HTTPS。不要填 `workers.dev`、`localhost`、邀请链接或任何账号密码。

GitHub Actions 工作流只部署 `dist/`，不会上传源文件、需求文件或 `.local/`。管理员通行密钥登录界面在 M1 放到 API 域名下，保持登录会话同源。

## 可达性自检

请在大陆实际网络上操作，香港网络或本机 localhost 结果不计入大陆验收。

1. 暂停设备的代理或 VPN，打开真实 Pages 首页。
2. 打开 `#/check`，手动选择运营商和网络，点击检测。
3. 前端检测会重新获取 `connectivity.json`，API 检测会请求 `/api/health`，均禁用 HTTP 缓存，最长等待 8 秒。
4. 分别覆盖电信、联通、移动的 4G/5G 和 Wi-Fi，共六种组合。无法覆盖的项目保留为未测，不推断通过。
5. 页面可保存当前浏览器最近 40 条记录。点击「下载测试记录」，汇总不同设备结果。清空只影响当前浏览器。

请在测试前准确选择网络。页面不会自动确认代理是否关闭，也不会自动识别运营商。所有结果只保存在本机浏览器，不上传测试记录。每条记录包含北京时间、运营商、网络类型和前端/API 的结果及耗时。没有 IP、位置、User-Agent 明细或邀请令牌。

只有前端和 API 都通过，才算该次网络测试通过。首页能打开但 API 失败时，预约功能仍不可用。

## 登录可行性探针

原定方案为 Argon2id + TOTP。Workers 免费版的 HTTP CPU 标称限制是 10 ms。先验证安全参数的计算成本，不通过降低密码保护参数来适配额度。

```bash
npm run probe:auth
```

脚本使用公开的虚构输入，按 Argon2id、19 MiB 内存、2 次迭代、并行度 1 计算五次，记录 Node 进程 CPU 耗时。本机完整结果保存到 `.local/auth-probe.json`，不提交到 Git。

还可以验证相同计算在本地 Workers 运行时能否执行。

```bash
npm run probe:worker
```

在另一个终端运行。

```bash
curl -X POST http://127.0.0.1:8788/probe
```

这个探针仅在本机 `127.0.0.1` 下启用，不接收真实密码，也不包含在正常 API 中。响应的 `cloudCpuVerified` 固定为 `false`。**本机 Node CPU 与本地 workerd 成功均不能替代 Cloudflare 线上 CPU 计量**。JavaScript 实现的结果也不能代表其他优化实现。

2026 年 11 月 5 日的真实部署中，JavaScript 与静态 WASM 实现分别有 5/12 和 6/12 次触发 Cloudflare CPU 超限（1102）。用户已选择保留每年 120 元预算，将后台登录改为通行密钥 + TOTP。

新的轻量探针对 TOTP、P-256 验签和两者组合各执行 12 次，36 次全部通过。它只验证密码学核心，不包含完整 WebAuthn 数据校验、数据库、会话或真实浏览器认证器。精确的云端 CPU 毫秒数没有读到，不能把 HTTP 耗时当作 CPU 计量。

需要复验时使用下列命令。线上命令会在当前账号部署带随机访问密钥和 20 分钟失效时间的探针，固定次数调用后删除该 Worker，使用虚构输入。运行前应先确认账号已启用免费 Workers 服务。

```bash
npm run probe:cloud:preflight
npm run probe:cloud -- --lightweight --local
npm run probe:cloud -- --lightweight
```

完整结果保存在 `.local/cloud-lightweight-probe.json`。原定密码方案的复验命令为 `npm run probe:cloud`，结果保存在 `.local/cloud-auth-probe.json`。探针不与正常 API 一起部署，真实网站 API 仍要求自有域名。中断运行后应检查本机记录中的 Worker 名称，并确认本次临时资源已清理。

## 后台登录与多设备体验

后台支持 iPhone、Mac、Windows 10 和 Windows 11，使用同一个管理员账号。各设备可以分别注册通行密钥，后台可查看并撤销某一设备的登录。移动端与桌面端均能管理日历来源、邮箱、预约、邀请、规则与展示内容，分里程碑实现。

- iPhone 可通过 Face ID 或设备解锁方式使用通行密钥。Mac 可使用系统提供的验证方式，也提供附近手机扫码路径。开启同一 Apple 账户的 iCloud 钥匙串后，两端可以同步通行密钥。
- Windows 10/11 可在支持的 Edge、Chrome 中使用 Windows Hello，按设备能力提供 PIN、指纹或人脸。优先允许每台常用电脑保存自己的通行密钥。
- 手机扫码路径需要两端联网、开启蓝牙且系统/浏览器支持。Windows 10 和 11 的具体界面不同，M1 必须实机验证，不能以 Windows 11 的界面代替 Windows 10 验收。
- 拟定为首次或会话到期时验证，提供「记住这台设备」，建议最长 30 天、后台可撤销。日常页面请求只校验会话，减少重复交互与计算。会话到期、退出、撤销或浏览器清理数据后需重新验证。
- 保留 TOTP。动态口令单独作为登录方式会改变认证强度，是否启用备用登录须明确配置。新增凭据、修改日历授权等敏感操作应重新验证。

M1 包含「登录设备」管理页。列表按浏览器登录会话展示设备昵称、系统、浏览器、首次登录、最近使用、有效期与当前设备标记，支持改昵称、移除指定登录和退出其他所有登录。它使用浏览器的系统信息生成粗粒度标签，不记录 IP 明细或做硬件指纹识别。同一台电脑的不同浏览器会作为不同登录显示。

撤销会话后，服务端立即拒绝该会话的后续请求。客户端收到失效响应后清理当前页面数据并回到登录入口。通行密钥在另一列表中管理，支持添加、命名和撤销。移除一个登录会话不会自动撤销其他设备共用的通行密钥；撤销已通过 iCloud 同步的通行密钥会使其所有副本在本站失效。凭据变更需要重新验证，避免误删后没有可用登录方式。

设备和浏览器行为依据 [Microsoft Windows 通行密钥文档](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/) 与 [Apple 通行密钥说明](https://support.apple.com/en-us/102195)。

官方资料可用于复核额度与参数。

- [Workers 资源限制](https://developers.cloudflare.com/workers/platform/limits/)
- [OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [本次探针使用的哈希库](https://github.com/paulmillr/noble-hashes)

## 日历接入预检

私人来源是 iCloud 中勾选的个人日历，工作 Outlook 当前通过订阅在 Apple 日历可见。两者均参与忙闲计算。多设备同步成功与允许本站读取忙闲需要分别验证。

后续接入需要完成以下检查，使用虚构日程即可。

- 核实单位账户是 M365 国际版、世纪互联还是本地 Exchange，并在组织允许的范围内进行独立只读授权。
- 验证 iCloud 能否只返回必要的忙闲字段。不要默认拉取完整事件后再删除标题。
- 验证新增、改期、取消，以及全天事件分别标为空闲和忙碌时的结果。
- 记录 Outlook → Apple 订阅的真实刷新延迟。Mac 刚上传数据不等于订阅上游已刷新。
- 服务器只保留开始、结束、全天和必要忙闲状态，不存事件标题、参与人、地点、正文或完整 ICS。
- 任何必要来源失效、过期或状态未知时，暂停自动确认，工作日保留邮件申请。周末仅接受已发布开放局的申请。

优先让云端直接读取合规的最小字段。只有必须依赖本机的来源才使用 Mac 转送。Mac 经常出差携带，不能假定它全天在线。正式同步和预约计算在 M3 完成。

## 已确认的预约规则

这些是后续里程碑的实现基线，M0 没有可用预约入口。

- 周一至周五普通可约窗口为基准时区 09:00–21:00，整段预约必须在窗口内。最远 30 天，起点每 30 分钟一个，时长 30、60、90、120 分钟。
- 当天的普通预约需要邮件确认，申请本身不占位。之后日期的合规空闲时段可直接预约。当天按 Asia/Shanghai 日期判断，这个边界来自本次方案建议。
- 工作日的已忙时段也可以提交申请。审批时重新核对冲突，不能覆盖另一份站内已确认预约。
- 周六、周日只通过模式二。普通申请不能绕过周末限制。
- 六种活动模板为 coffee chat、lunch、dinner、bar talk、airport chat、video call，均默认一小时，创建时可调。默认名额 1、姓名必填、直接确认，每场可调整。
- 主动开放的活动可以临时发布，不受统一的 24 小时提前量限制。地点仅展示城市，具体城市、日程与可见权限由后台设置。
- 收件邮箱和发信凭据在后续后台填写，不作为前端常量或样例数据提交。

## 方案 2 · 切换到同域服务器

同一套 API 的入口在 `server/app.ts`，Workers 和普通 Node 分别使用薄入口适配。M0 没有持久化业务数据，当前切换不涉及数据迁移。后续引入 D1 时需增加 SQLite 适配和备份恢复验证，不能把 D1 绑定直接带到 Node。

先在本机验证同域版本。

```bash
npm run build
npm start
```

打开 `http://127.0.0.1:3000/#/check`。前端构建默认使用 `/api`。若此前在本机 `.env` 设置了独立 API，请将 `VITE_API_BASE_URL` 改回 `/api` 后重新构建。

部署到香港服务器时先安装 Docker 和 Compose，将域名 A/AAAA 记录指向服务器，开放 80、443 端口，然后复制运行。

```bash
cp .env.example .env
```

编辑 `.env` 中的 `SITE_DOMAIN` 为真实域名，例如 `booking.your-domain.com`，不带协议。然后运行。

```bash
docker compose config
docker compose up -d --build
docker compose logs --tail=50
```

Caddy 自动申请 HTTPS 证书。通过 `https://你的域名/#/check` 验证。该方案前端和 API 同域，保留同一套邀请入口格式。Caddy 配置没有开启访问日志。证书卷需要在迁移服务器时保留。M0 无个人业务数据库，数据库自动备份将在持久化里程碑中加入。

## 检查命令与排错

```bash
npm run check
npm test
npm run build
npm run dry-run:api
```

API 检查覆盖固定公开信号、缓存/索引头、精确 CORS、预检请求、未配置源时的拒绝，以及所有业务接口关闭。

| 表现 | 处理方式 |
| --- | --- |
| 首页只显示「仅限受邀访问」 | 根路径的预期行为。M0 自检使用 `#/check` |
| 邀请页提示不可用 | M0 尚未实现有效邀请门禁，所有令牌统一关闭 |
| 页面通过，API 失败 | 检查 API 是否启动、构建变量是否正确、FRONTEND_ORIGIN 是否与浏览器源完全一致 |
| API 直接打开能返回，页面检测却失败 | 检查 CORS 源、HTTPS 混合内容和静态页面的 CSP 配置 |
| Workers 提示未登录 | 在自己电脑运行 `npx wrangler login`，再运行 `npx wrangler whoami` |
| Worker 域名绑定失败 | 确认域名在当前 Cloudflare 账号且 DNS 区域已经生效，API 域名没有冲突记录 |
| 项目站资源 404 | 确认工作流上传的是 `dist/`，保留 Vite 的相对 base 配置 |
| Node/Vite 报版本不支持 | 使用 Node.js 22.12 以上版本，重新 `npm ci` |
| 检测记录刷新后丢失 | 检查隐私浏览或存储权限，下载 CSV 保存。不同浏览器不会共享记录 |
| HTTPS 证书申请失败 | 检查 DNS 是否指向服务器和 80/443 是否开放，查看 Caddy 日志 |

`npm run dry-run:api` 只生成 Worker 构建，不等于已经线上部署。Docker 配置是否在实际服务器可用，需要部署后单独验收。
