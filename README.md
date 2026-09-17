# book-to-remote

WorkBuddy Skill：从 Z-Library 下载电子书，并导入微信读书（WeRead）和 Kindle 阅读器。

> **改名说明（2026-09-17）**：本 skill 原名 `zlibrary-to-weread-kindle-wechatreader`，现更名为 **`book-to-remote`**。GitHub 仓库同步改名，旧链接由 GitHub 自动重定向。已有使用者把本地 skill 目录一并改名即可：
> ```bash
> mv ~/.workbuddy/skills/zlibrary-to-weread-kindle-wechatreader ~/.workbuddy/skills/book-to-remote
> ```

一条链路打通：**搜书下载 → 文件验证 → 微信读书导入 → Kindle 导入（邮件优先，网页兜底）**。

---

## 更新点（2026-09-16 · 晚）：Kindle 改为邮件优先 + 引导式配置

### 1. 投送路由硬规则

Kindle 投送**默认且首选邮件投送**，并把它固化成不可绕过的规则：

1. 默认邮件（7A）。网页投送不再是"平级选项"，而是**兜底路径**。
2. 邮件路不通时，**先引导用户完成亚马逊侧配置（7A-0）**，把配置当成任务的一部分推进——而不是因为"网页投送不用配置"就抄近路。
3. **只有两种情况**允许切网页投送（7B），进入前必须说得出是哪条：
   - **(a) 体积超限**：文件 > 实测上限 ~5.25MB；
   - **(b) 用户明确拒绝**配置。
4. **用户沉默 ≠ 拒绝**。已发出引导但用户没回时**停下等待**，不得自行降级。
5. 降级后必须在汇报里写明走哪条路、为什么。

### 2. 新增「7A-0 前置配置引导」章节

把原来散落的引导话术收敛成一个必过关卡，三项检查逐项做、缺哪补哪：

| # | 检查项 | 是否需用户动手 |
|---|--------|---------------|
| 1 | Agent Mail 连接器已开通 | 用户开通 |
| 2 | Kindle 收件地址已固化到本地配置 | **否**（CDP 自动读亚马逊 pdoc 页，抓到后 `setup` 写入，无需用户抄） |
| 3 | 发件地址已在亚马逊「已批准的个人文档电子邮件发送列表」 | **是**（唯一必须手动的一步，skill 无法代劳） |

配套给了**引导话术模板**：一次说清「做什么 + 为什么 + 一次性长期有效 + 不想做的替代方案」四件事，并在用户拒绝后停止劝说。同时增加了「**先自动查白名单，已放行就别打扰用户**」的免打扰分支。

### 3. 修正 Agent Mail 附件体积上限

实测定位：`agent_mail_upload_attachment` 的**真实上限约 5.25MB**（5.0MB 通过 / 5.5MB 失败，报 `400 Validation failed on field: xmail.UploadFileReq.content`），远低于 `GetMe` 宣称的 20MB。已写入文档并给出判定方法与易混错误（扩展名被拒 `blocked attachment` 与体积无关）。

### 4. 修复 Send to Kindle 网页投送的静默失败

`stk-drop.mjs` 原用 `[class*=s2k-dnd]` 选择器，会**误命中 `.s2k-dnd-hero-image`（装饰大图）**，drop 打空却仍返回 `"dropped ..."`。现已改为优先级链 `#s2k-dnd-area → .s2k-dnd-box → .stk-dnd-home-functioning-area → .s2k-wrapper`，且返回值带上目标 id/class 便于核验。

### 5. 补全网页投送（7B）与微信读书（步骤 6）的可执行细节

- 微信读书：上传框用 CDP 代理 `/setFiles`（body `{selector, files}`），不是 `/click`。
- 7B：原生 `<dialog>` 定位、`action_button` 必须用真鼠标事件（`/clickAt`）、复选框要点 `span#<listId>_0_checkmark`（input 是 `aria-hidden`）、个人文档列表直达 `.../contentlist/pdocs/dateDsc/`。

---

## 更新点（2026-09-16 · 架构重构）

本次为架构级重构，**不再需要安装 Z-Library 桌面客户端**，下载过程也不再弹窗抢占本机。

### 1. 移除 Z-Library.app 依赖

旧版把 APP 当作「凭据容器」（读 `~/Library/Application Support/z-library/config.json` 里的 `remix_userid` / `remix_userkey`），没装 APP 就无法使用。

新版把凭据来源改为两条，都不强依赖 APP：

- `login`：在浏览器里登录一次 z-library，脚本轮询 `document.cookie` 抓取凭据——**推荐路径，无需装任何客户端**
- `import-app`：若本机确实装过 APP，一键把凭据导入

能这样做的原因：这两个 cookie **不是 HttpOnly**，`document.cookie` 可读可写；且**页面内同源 fetch `/eapi/*` 不会被 DiamWall 反爬墙拦**（而 Node/curl 直接请求部分域名会陷入 307 重定向死循环，这正是旧版被迫依赖 APP 凭据、并把请求打到可疑域名的根因）。

### 2. 下载改为静默（不抢本机焦点）

旧版用 Playwright `headless:false` 启动一个**全新的 Chrome 窗口**，会弹窗并抢走焦点。

新版**不启动新浏览器**，而是复用用户已开启调试端口的日常浏览器，通过 CDP 创建 `background: true` 的**后台标签页**完成搜索与下载——全程无窗口、无焦点抢占。

> 为什么不用无头（headless）：实测 `bundled-chromium-headless` 与 `chrome-headless` 均被反爬识别，返回 `Try again later`。真正的静默靠「复用已有浏览器 + 后台标签页」，而不是靠无头。

### 3. 安全修复：剔除被标记为钓鱼的域名

旧版的 `PREFERRED_DOMAINS` 把 `z-library.ec` 排在**首选**，而该域名在浏览器中会显示 Cloudflare 的 **`Suspected Phishing`** 全屏警告——等于拿用户账号凭据去请求一个被标记为钓鱼的站点。

新版已从所有脚本中剔除该域名，改用官方客户端下发的权威域名列表（首选 `z-lib.sk`）。

### 4. 新增统一主入口 `scripts/zlib-cdp.mjs`

旧版功能散落在多个脚本中、职责重叠。新版收敛为单一入口，子命令：

| 子命令 | 作用 |
|--------|------|
| `check` | 环境自检（CDP 代理 / 凭据 / 本地配置），并明确告知缺什么、下一步敲什么 |
| `setup` | 固化 Kindle 收件与发件地址（写入本机私有配置） |
| `login` | 浏览器登录一次，自动抓取凭据 |
| `import-app` | 从已安装的 Z-Library.app 导入凭据 |
| `search` | 搜书，列出候选版本元数据 |
| `download` | 静默下载到指定路径（支持 `--query` 自动选书） |

### 5. 私有信息本地化

Kindle 收件地址、Agent Mail 发件地址、Z-Library 凭据统一存放在 **`~/.workbuddy/zlibrary/config.local.json`**（权限 600，目录 700），**位于 skill 目录之外**，不会随本仓库外泄。本仓库中的所有邮箱均为占位符（如 `xxx_xxx@kindle.com`）。

### 6. 清理历史脚本

`chrome-download.mjs`、`zl-cdp-download.mjs`、`zlib-download.mjs` 三个职责重叠的历史尝试已删除，功能全部由 `zlib-cdp.mjs` 覆盖。

### 7. 新增浏览器环境要求说明

详见下节。这是新环境最容易卡住的一关。

## 环境要求（重要）

本 skill 所有浏览器交互都经 `web-access` skill 的 CDP 代理（`localhost:3456`），有两条**硬要求**：

### ① 必须是 Chromium 内核浏览器

可选 `chrome` / `chrome-canary` / `chromium` / `edge`。

**Safari 与 Firefox 不支持，且不是改配置能解决的**：Safari 只提供 `safaridriver`（WebDriver 协议），Firefox 走 RDP / WebDriver BiDi，两者都不暴露 CDP 端点、不生成 `DevToolsActivePort` 文件、也不支持 `--remote-debugging-port`。本链路依赖的 `Target.createTarget` / `Page.navigate` / `Runtime.evaluate` 等均为 Chromium CDP 专有方法。

→ 若你只用 Safari / Firefox，请先安装 Edge 或 Chrome（均免费）。

### ② 必须手动开启远程调试

这是**非默认设置**，新环境几乎必然卡在这里：

1. 地址栏访问 `chrome://inspect/#remote-debugging`（Edge 用 `edge://inspect/#remote-debugging`）
2. 勾选 **"Allow remote debugging for this browser instance"**
3. 运行 `check-deps.mjs` 确认连上

> 原理：开启后浏览器才会在自己的 user-data-dir 写出 `DevToolsActivePort` 文件（首行为调试端口号），发现脚本正是读该文件定位端口。**检测不到浏览器时，先怀疑「开关没开」，而不是「没装」。**

建议在 `web-access/config.env` 中固定默认浏览器（如 `WEB_ACCESS_BROWSER=chrome`），否则每次都会返回 `ambiguous` 反复询问。

## 目录结构

```
.
├── SKILL.md                        # skill 定义与完整使用说明
└── scripts/
    ├── zlib-cdp.mjs                # 主入口：check/setup/login/import-app/search/download
    ├── verify-ebook.mjs            # 电子书文件格式与完整性验证
    ├── stk-drop.mjs                # Kindle 网页投送：base64 注入 + drop
    └── zlib-browser-dl.mjs         # 兜底下载（CDP 代理不可用时用 Playwright，会弹窗）
```

## 安装（供其他 Agent 使用）

```bash
git clone https://github.com/hohoweiyao-cmyk/book-to-remote.git \
  ~/.workbuddy/skills/book-to-remote
```

## 其他依赖

| # | 依赖 | 说明 |
|---|------|------|
| 1 | `web-access` skill | 提供 CDP 代理，复用浏览器登录态（微信读书 / 亚马逊） |
| 2 | Chromium 系浏览器 + 已开远程调试 | 见上方「环境要求」 |
| 3 | 网络可达 z-library 镜像 | 部分地区需自备代理 |
| 4 | Agent Mail 连接器 | 仅「Kindle 邮件投送」需要；不走邮件可跳过 |
| 5 | Playwright + Chromium | 仅兜底下载路径需要；主路径不需要 |

**不再需要 Z-Library.app。**

## 使用

```bash
SKILL=~/.workbuddy/skills/book-to-remote

# 0) 确保 CDP 代理就绪
node ~/.workbuddy/skills/web-access/scripts/check-deps.mjs

# 1) 自检
node "$SKILL/scripts/zlib-cdp.mjs" check

# 2) 取凭据（二选一，推荐 login）
node "$SKILL/scripts/zlib-cdp.mjs" login
node "$SKILL/scripts/zlib-cdp.mjs" import-app

# 3) 固化 Kindle 收件/发件地址（私有信息，只写本机）
node "$SKILL/scripts/zlib-cdp.mjs" setup --kindle-email "<你的>@kindle.com" --sender "<发件>@agent.qq.com"

# 4) 搜书 / 下载
node "$SKILL/scripts/zlib-cdp.mjs" search "书名 作者" --format epub
node "$SKILL/scripts/zlib-cdp.mjs" download --query "书名 作者" --out "$HOME/Downloads/书名.epub"

# 5) 校验
node "$SKILL/scripts/verify-ebook.mjs" "$HOME/Downloads/书名.epub"
```

微信读书导入、Kindle 投送的完整交互步骤见 `SKILL.md`。

**Kindle 投送顺序（邮件优先）**：

1. 走 `SKILL.md` 的 **7A-0 前置配置引导**，三项检查一次做齐。其中只有「把发件地址加入亚马逊白名单」需要用户动手，**一次性配置、长期有效**。
2. 配置齐了就默认走**邮件投送（7A）**。
3. 仅当 ① 文件 > 5.25MB，或 ② 用户**明确拒绝**配置时，才切**网页投送（7B）**。

> 用户没回应配置引导时**应等待**，不要默认降级为网页投送。

## 隐私说明

- 本仓库**不硬编码任何私有账号信息**，所有邮箱均为占位符。
- 运行时凭据与投送地址由使用者在本机自行配置，存放于 `~/.workbuddy/zlibrary/config.local.json`（skill 目录之外）。
- 使用者的 Kindle 专属邮箱须自行在亚马逊「个人文档设置」中查看并填入。
- 投送前请把发件地址加入亚马逊「已批准的个人文档电子邮件发送列表」，否则会被拒收。

## 许可

仅供个人学习与自用。请遵守所在地区法律法规及 Z-Library 的服务条款，支持正版。
