---
name: book-to-remote
description: 从 Z-Library 找书、静默下载 epub，再导入微信读书（WeRead）与 Kindle。不需要安装 Z-Library.app，不弹浏览器窗口、不抢本机焦点。触发词：book-to-remote、zlibrary 下载、z-library 找书、下载电子书导入微信读书、传到 Kindle、send to kindle、导入 kindle、weread 导入、邮件投送 kindle。
agent_created: true
---

# book-to-remote：找书下载 → 微信读书 / Kindle

**搜书下载 → 文件验证 → 微信读书导入 → Kindle 导入（邮件优先，网页兜底）。**

> **改名说明（2026-09-17）**：本 skill 原名 `zlibrary-to-weread-kindle-wechatreader`，现更名 `book-to-remote`。目录也需同名，否则 skill 无法被正确加载：
> ```bash
> mv ~/.workbuddy/skills/zlibrary-to-weread-kindle-wechatreader ~/.workbuddy/skills/book-to-remote
> ```

## 架构要点（2026-09-16 重构，先看这段）

| 问题 | 结论 |
|------|------|
| 需要 Z-Library.app 吗？ | **不需要**。APP 的唯一作用只是「存凭据」。现在凭据由本地私有配置持有，来源可以是浏览器登录（`login`）或从已装的 APP 导入（`import-app`）。 |
| 下载为什么要用浏览器？ | z-library 的 `/dl` 有 JS 反爬盾，curl 与无头浏览器都过不去（实测 headless 全部拿到 `Try again later`）。**必须真实浏览器环境**。 |
| 会弹窗抢本机使用吗？ | **不会**。不再新开浏览器，而是复用用户已开启调试端口的 Chrome，用 `background: true` 的**后台标签页**完成搜索与下载。 |
| 用哪个域名？ | 只用官方客户端下发的权威域名（首选 `z-lib.sk`）。**已剔除 `z-library.ec`**——该域被 Cloudflare 标记为 `Suspected Phishing`。 |
| 对浏览器有什么要求？ | **必须是 Chromium 系**（Chrome / Edge / Chromium）**且已手动开启远程调试**。Safari 与 Firefox 不支持，见下方「浏览器前置条件」——这是新环境最容易卡住的一关。 |
| Kindle 走邮件还是网页投送？ | **默认邮件（7A）**。邮件走不通时先**引导用户完成亚马逊配置（7A-0）**，而不是直接降级。**仅两种情况**才用网页投送：① 文件 > 5.25MB（邮件上传实测上限）；② 用户**明确拒绝**配置。用户沉默 ≠ 拒绝，须等待。详见步骤 7 的「投送路由硬规则」。 |

---

## 浏览器前置条件（换新环境前必查）

本 skill 所有浏览器交互都经 `web-access` 的 CDP 代理（`localhost:3456`），因此有三条**硬要求**：

**① 必须是 Chromium 内核浏览器。** `web-access/scripts/browser-discovery.mjs` 的白名单是硬编码的：

| 平台 | 支持的浏览器 |
|------|-------------|
| macOS | Chrome / Chrome Canary / Chromium / Microsoft Edge |
| Windows | Chrome / Chromium / Microsoft Edge |
| Linux | Chrome / Chromium / Microsoft Edge |

**Safari 与 Firefox 不在名单里，而且不是「加个配置项」能解决的**：Safari 只提供 `safaridriver`（WebDriver 协议），Firefox 走 RDP / WebDriver BiDi，两者都没有 CDP 端点，也不会生成 `DevToolsActivePort` 文件，更不支持 `--remote-debugging-port`。而 `cdp-proxy.mjs` 依赖的 `Target.createTarget` / `Page.navigate` / `Runtime.evaluate` / `Page.captureScreenshot` 全是 Chromium CDP 专有方法——换协议等于重写整个驱动层。

**② 必须已手动开启远程调试**（非默认设置，新环境 100% 会卡在这）：

1. 在目标浏览器地址栏打开 `chrome://inspect/#remote-debugging`（Edge 用 `edge://inspect/#remote-debugging`）
2. 勾选 **"Allow remote debugging for this browser instance"**
3. 重跑 `check-deps.mjs` 确认连上

> 为什么必须要这一步：浏览器只在开关打开后，才会在自己的 user-data-dir 写出 `DevToolsActivePort` 文件（首行是调试端口号），而 `browser-discovery.mjs` 正是靠读这个文件来探测浏览器的。**检测不到浏览器时，先怀疑"开关没开"，而不是"没装"。**

> **本机已固定偏好**：`web-access/config.env` 中 `WEB_ACCESS_BROWSER=chrome`，因此 `check-deps.mjs` 现在直接返回 `browser: ok (Chrome, port 9222) [config.env 偏好]`，不再每次询问。**给其他使用者部署时也建议首次就固定**——该文件是 git ignored 的本机配置，不会进仓库。想换浏览器改这一行即可（切换后须 `pkill -f cdp-proxy.mjs` 再重跑，因为 proxy 是长驻进程）。
>
> ⚠️ **注意**：`web-access` 是从技能市场安装的第三方 skill（非本 skill 自建），其 `SKILL.md` 里也补了同样的「环境要求」章节，但**市场版本升级时那份说明可能被覆盖**（`config.env` 是本机配置文件，一般不受影响）。因此本节是**自包含的完整副本**，两者冲突时以本节为准。

**③ 会弹「要允许远程调试吗？」授权框，按「每条新建连接」弹一次，且无法关闭。**

这两个东西极容易混为一谈，务必分清：

| | 开关 / 弹窗 | 作用域 | 能否持久化 |
|---|---|---|---|
| 开端口 | `chrome://inspect/#remote-debugging` 的勾选框 | 整个浏览器实例 | ✅ 已写入 `Local State` → `devtools.remote_debugging.user-enabled` |
| **放行谁连** | **「要允许远程调试吗？」弹窗** | **每一条新建 WebSocket 连接** | ❌ Chrome 明确拒绝 |

Chrome 官方在 `ChromeDevTools/chrome-devtools-mcp#825` 里给的结论（已 close as *not planned*）：

> There is no simple solution that also would not allow any program on the machine to easily access your data in Chrome.
> For now, we recommend to **have longer connection sessions** to avoid the reconnect dialog.

理由：一旦能持久化，本机任意程序都能静默读走你的 Cookie 与密码库。官方给的两条出路是「**保持长连接**」和「**专用 profile + `--remote-debugging-port` 启动**（结构上永不弹窗，代价是没有你的登录态）」。

**卡在这里的三个特征**（任一命中就是没授权，不要往别处查）：

| 现象 | 含义 |
|------|------|
| `curl 127.0.0.1:9222/json/version` 返回 **404 空 body** | 未批准前 Chrome 不提供 HTTP 端点 |
| 代理 `/health` 显示 `connected: null`、`chromePort: null` | 连接未建立 |
| 代理 `/targets`、`/eval` **超时** | TCP 已 ESTABLISHED，但 WS 握手被挂起等授权 |

> 历史坑（已在 `web-access/scripts/cdp-proxy.mjs` 修掉）：原 `connect()` 只监听 `open`/`error`/`close`，Chrome 挂起握手时三者都不触发，导致 `connectingPromise` **永不 settle**，代理静默假死且没有任何报错。现已加 `HANDSHAKE_TIMEOUT_MS`（默认 20s，可用环境变量覆盖），超时后明确报「Chrome 正在等待授权」。
> ⚠️ `web-access` 是市场安装的第三方 skill，这处改动在它升级时**可能被覆盖**；届时重新打补丁即可。

### 授权弹窗自动化（2026-09-17 新增，本机已配）

为解决「每轮任务都要手点允许」，本机装了两个常驻守护（脚本在 `~/.workbuddy/tools/`，刻意放在 skill 目录外，避免被市场升级覆盖）：

| 组件 | 作用 |
|------|------|
| `cdp-proxy-daemon.sh` + `com.damon.cdp-proxy.plist` | CDP 代理常驻（官方建议的 long session）。`KeepAlive`，崩了自动拉起，开机自启 |
| `cdp-allow-dialog.applescript` + `cdp-allow-dialog.sh` + `com.damon.cdp-allow-dialog.plist` | 每 3s 扫一次 Chrome 的授权弹窗，命中就自动点「允许」 |
| `cdp-setup.sh` | 一键安装 / 卸载 / 自检 |

```bash
bash ~/.workbuddy/tools/cdp-setup.sh            # 安装 + 自检
bash ~/.workbuddy/tools/cdp-setup.sh --status    # 只看状态
bash ~/.workbuddy/tools/cdp-setup.sh --remove    # 卸载
```

三个设计要点（踩过才总结出来的，改脚本前先读）：

1. **必须在真实 Terminal 里装。** `launchctl bootstrap gui/<uid>` 要求调用方处于 Aqua 登录会话；从 AI 助手的脚本沙箱里调用会稳定报 `Bootstrap failed: 5: Input/output error`——连 `/bin/date` 这种最小 agent 也一样，不是 plist 写错了。
2. **弹窗守护的入口必须是 `/usr/bin/osascript`，不能包一层 bash。** macOS 的辅助功能（TCC）授权按「主可执行文件」判定：用 `/bin/bash` 做入口就得把 `/bin/bash` 加进辅助功能，等于任何脚本都能驱动 UI，授权面太宽。所以该 plist 用 `StartInterval` 定时轮询（而非 `KeepAlive` 常驻循环），让入口保持 osascript，用户只需授权这一个系统脚本。
3. **安全守卫是三层**：只扫特定浏览器进程 → 容器必须是 dialog/sheet/alert/modal 角色 → 弹窗文本必须命中远程调试类关键词。任一不满足都不点。AppleScript 只在**真的点击**时才写日志，所以定时轮询不会刷爆日志文件。

### 如果用户机器上只有 Safari / Firefox

（macOS 默认浏览器是 Safari、Linux 默认是 Firefox，都是高发场景）按影响面分三层处理：

| 环节 | 非 Chromium 环境 | 说明 |
|------|-----------------|------|
| 搜书 / 下载 epub | ⚠️ 需走兜底 | `zlib-browser-dl.mjs` 用 **Playwright 自带的 Chromium**，不依赖用户装浏览器；但 `headless:false` 会**弹窗抢焦点**，且需先装 `playwright` + `npx playwright install chromium` |
| 微信读书导入 / Kindle 网页投送 / 读亚马逊 Kindle 邮箱 | ❌ 不可用 | 这三步强依赖 CDP 代理，**没有非 Chromium 兜底** |
| Kindle 邮件投送 / epub 校验 | ✅ 不受影响 | 走 Agent Mail 连接器与纯 Node 文件校验，与浏览器无关 |

**给用户的首选建议**：装一个 Chromium 系浏览器最省事（Windows 自带 Edge 通常直接可用）。此时务必同时走完上面「② 开启远程调试」，否则仍然连不上。

---

## 快速开始（新用户照这个顺序走）

```bash
SKILL=/Users/<你>/.workbuddy/skills/book-to-remote

# 0) 先确保 web-access 的 CDP 代理已连上用户浏览器
#    本机已在 web-access/config.env 固定 WEB_ACCESS_BROWSER=chrome，直接跑即可（无需参数）
#    换环境时：浏览器 id 只能是 chrome / chrome-canary / chromium / edge，见「浏览器前置条件」
node "/Users/<你>/.workbuddy/skills/web-access/scripts/check-deps.mjs"

# 1) 自检：会告出「缺什么、下一步敲什么」
node "$SKILL/scripts/zlib-cdp.mjs" check

# 2) 取凭据（二选一）
node "$SKILL/scripts/zlib-cdp.mjs" login        # 浏览器登录一次，自动抓取（推荐，不需要 APP）
node "$SKILL/scripts/zlib-cdp.mjs" import-app   # 本机若已装 Z-Library.app，一键导入

# 3) 固化 Kindle 收件/发件地址（私有信息，只写本机）
node "$SKILL/scripts/zlib-cdp.mjs" setup --kindle-email "<你的>@kindle.com" --sender "<发件>@agent.qq.com"

# 4) 搜书
node "$SKILL/scripts/zlib-cdp.mjs" search "书名 作者" --format epub

# 5) 静默下载（不弹窗）
node "$SKILL/scripts/zlib-cdp.mjs" download --id <id> --hash <hash> --out "$HOME/Downloads/书名.epub"

# 6) 校验后再投送
node "$SKILL/scripts/verify-ebook.mjs" "$HOME/Downloads/书名.epub"
```

**投送阶段的顺序（先把邮件路的配置一次做齐，之后每本书都省事）**：

1. 微信读书导入（步骤 6）。
2. **Kindle 走邮件优先**：先跑 7A-0 的三项检查 → 需要用户动手的只有「把发件地址加入亚马逊白名单」这一条，**一次配好长期有效**。
3. 体积 >5.25MB 或用户明确拒绝配置时，才切 7B 网页投送。

---

## 本地私有配置（重要：不会随仓库外泄）

**位置（刻意放在 skill 目录之外）**

```
~/.workbuddy/zlibrary/config.local.json     # 权限 600，目录 700
```

放在这里的原因：skill 目录会被同步到 GitHub，而 Kindle 邮箱、Agent Mail 发件地址、z-library 凭据都属于私有账号信息，**任何情况下都不允许写进 SKILL.md、脚本或仓库**。

**字段**

| 字段 | 含义 | 怎么填 |
|------|------|--------|
| `kindle_email` | Kindle 专属收件地址，形如 `xxx_xxx@kindle.com`（统一小写） | `setup --kindle-email <它>`；或由 agent 用 CDP 打开亚马逊「个人文档设置」页读取 |
| `agent_mail_sender` | Agent Mail 的发件地址（`GetMe` 返回的主别名，形如 `xxx@agent.qq.com`） | `setup --sender <它>` |
| `kindle_device` | 默认 Kindle 设备名（网页投送时勾选用） | `setup --device "<设备名>"` |
| `download_dir` | 下载目录覆盖（默认自动探测 Chrome 的下载目录） | `setup --download-dir <目录>` |
| `domain` | 上次可用的 z-library 域名（自动写入） | 无需手填 |
| `credentials` | `remix_userid` / `remix_userkey` 及来源标记 | `login` 或 `import-app` 自动写入 |

### 给「别人用这个 skill」的引导话术（收件 & 发件地址固定化）

首次帮新用户配置时，按这个顺序问、按这个顺序写：

1. **收件地址**——"你的 Kindle 专属邮箱是多少？在亚马逊 → 管理你的内容和设备 → 偏好设置 → 个人文档设置 里能看到，形如 `xxx_xxx@kindle.com`。"
   - 不想让用户手抄时，可用 CDP 直接读（见步骤 6A）：打开 `https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc`，`/eval` 抓 `/[A-Za-z0-9._%+-]+@kindle\.com/i`。
2. **发件地址**——先调 Agent Mail 的 `GetMe` 拿主别名，然后**明确告知用户**：
   > "我会用 `<发件地址>` 给你投书。请把它加入亚马逊『已批准的个人文档电子邮件发送列表』，否则亚马逊会直接拒收。"
   - 这个白名单动作**只能用户手动做**，skill 无法代劳。
   - 可顺手在同一个亚马逊页面上 `grep` 一遍：若正文里已出现该发件地址，说明早就放行过，不用再折腾用户。
3. **写入本地**——`setup --kindle-email ... --sender ...`，然后用 `check` 复核（`check` 只显示脱敏值）。

---

## 工作流

### 步骤 1：环境自检（每轮必做）

```bash
node "<skill_dir>/scripts/zlib-cdp.mjs" check
```

输出会明确给出缺什么、下一步敲什么。三项齐了（CDP 代理 ✓ / 凭据 ✓ / 本地配置 ✓）再往下走。

### 步骤 2：取凭据

- `login`：在用户的 Chrome 里开一个后台标签页到 z-library，用户在浏览器里登录一次，脚本轮询 `document.cookie` 抓到 `remix_userid/remix_userkey` 后落盘。**这是不用装 APP 的主路径。**
  - 注意：`/new` 创建的是后台标签页，不会自动切到前台。脚本会提示用户手动切过去。
  - 为什么能这样抓：这两个 cookie **不是 HttpOnly**，`document.cookie` 可读可写（实测）。正因如此，也能反过来把凭据注入到浏览器里用。
- `import-app`：本机已装 Z-Library.app 时一键搬走凭据，之后就可以卸载 APP 了。
- 凭据只是**搬了一次家**，之后所有请求都在浏览器内带着 cookie 发出。

### 步骤 3：搜书 + 选书

```bash
node "<skill_dir>/scripts/zlib-cdp.mjs" search "书名 作者" --format epub
```

脚本会先探测出**当前可用的权威域名**（首选 `z-lib.sk`），再在页面内 `fetch('/eapi/book/search')` 拿结果——同源请求，DiamWall 不拦。

**同名多版本时怎么选（中文书尤其重要）**：同书名常有 20 条（0.4MB / 0.7MB / 1.3MB / 2.2MB / 44MB PDF…），**接口不返回评分和下载量，所以「体积最大」不等于「质量最好」**。取 2 个候选拆包比较：

```bash
mkdir -p /tmp/ep && unzip -q -o 书.epub -d /tmp/ep
# 1) 正文字数（去标签）——判断是否完整
find /tmp/ep -type f \( -name "*.html" -o -name "*.xhtml" \) -exec cat {} \; | sed -e 's/<[^>]*>//g' | tr -d '[:space:]' | wc -c
# 2) 末章结尾——是否以「（全文完）」正常收尾
sed -e 's/<[^>]*>//g' $(ls /tmp/ep/OEBPS/Text/*.html 2>/dev/null | tail -1) | tail -c 300
# 3) 封面——`file` 出 HUAWEI/手机机型 EXIF 说明封面是手机翻拍，多半是民间精排本
file /tmp/ep/OEBPS/Images/*
```

**识别「带广告的民间精排本」**：正文里出现 `微信公众号` / `ewm`（二维码图）/ 宣传页的，末页往往就是公众号广告（实测某 2.19MB「精排」本末页为「微信公众号：哎呀精读」，封面是华为手机翻拍）。这类版本**不要投送**；改用结构干净、`<meta name="cover">` 元数据齐全、以「（全文完）」收尾的版本。

### 步骤 4：静默下载

```bash
node "<skill_dir>/scripts/zlib-cdp.mjs" download --id <id> --hash <hash> --out "$HOME/Downloads/书名.epub"
# 或让脚本按打分自动选书：--query "书名 作者"
```

内部过程（**全程在后台标签页，不弹窗、不抢焦点**）：

1. 建后台标签页 → 探测可用域名 → 导航到站点根路径（顺带让浏览器自然过掉 DiamWall）；
2. `document.cookie` 注入凭据；
3. 页面内 `fetch('/eapi/book/<id>/<hash>')` 取 `dl` 真实下载链接；
4. 导航该标签页到 `https://<域名>/dl/xxxx` → **Chrome 自己落盘**到它的下载目录；
5. 轮询新文件出现 → 按 `--out` 重命名移动；结束后关闭自己创建的标签页。

**前提条件（写进用户告知里）**：Chrome 需关闭「下载前询问每个文件的保存位置」（`chrome://settings/downloads`），否则下载会卡住不落盘；脚本 90s 超时后会给出这条提示。

**为什么不用无头**：`bundled-chromium-headless` 与 `chrome-headless` 实测都被识别，返回 `Try again later`。所以别为了"安静"去改 headless——真正的静默靠「复用用户已有的浏览器 + 后台标签页」，而不是靠无头。

### 步骤 5：验证文件（上传前必做）

```bash
node "<skill_dir>/scripts/verify-ebook.mjs" <文件路径>
```

`ok:false` → 停下报告，不继续上传。记录文件名、扩展名、大小。微信读书与 Kindle 都吃 epub，默认就用 epub。

### 步骤 6：导入微信读书（web-access CDP）

1. CDP 新建 tab：`POST http://localhost:3456/new` → `https://weread.qq.com/web/upload`（**直达上传页，别找书架弹窗**）。
2. `/eval` 判断登录态；未登录 → 让用户在自己浏览器扫码（一次性，之后常态化）。
3. `/eval` 找到 `input[type=file]`（上传页仅一个，`accept` 已含 epub），用 `/setFiles` 设本地路径绕过文件对话框。
4. 轮询「导入完成」，然后**以书架出现书名才算成功**（导航到 `/web/shelf` 检查，别只看上传页文案）。

**微信读书坑（必记）**：
- Chrome 会限流后台标签，上传卡 ~49% 是**被限速不是失败**，把上传页标签切前台（或让用户点一下）几秒即传完。
- 上传超时点「重试」，前台重传很快。

### 步骤 7：导入 Kindle —— 邮件优先，网页兜底

#### 投送路由硬规则（不得违反）

1. **默认且首选邮件投送（7A）**。这是标准路径，不因"网页投送不用配置"就抄近路。
2. 邮件路走不通时，**先引导用户完成亚马逊侧配置（7A-0）**，把配置当成任务的一部分去推进——而不是直接降级。配置是**一次性**的，配完以后每本书都省事。
3. **只有下面两种情况**才允许切到网页投送（7B），进入前必须能明确指出是哪一条：
   - **(a) 体积超限**：文件大于邮件上传的实测上限 ~5.25MB（见 7A 第 6 条），邮件路物理上走不通；
   - **(b) 用户明确拒绝**：用户被引导后**明确表态**不愿配置（"不想弄"、"太麻烦"、"跳过吧"、"就用网页"）。
4. **用户沉默 ≠ 拒绝**。若已发出配置引导但用户还没回，**停下等待**，不得自行降级；也**不得**用"网页投送也能成"来自我合理化跳过引导。
5. 降级后必须在最终汇报里写明走的哪条路、为什么，以及让用户知道"以后配一次就能默认走邮件"。

#### 7A-0. 前置：引导用户完成亚马逊必要配置（走邮件路的必过关卡）

三项逐项查，缺哪补哪：

| # | 检查项 | 怎么查 | 缺了怎么办 |
|---|--------|--------|-----------|
| 1 | Agent Mail 连接器已开通 | 调 `GetMe` | 用户侧开通，skill 无法代劳；明确告知并暂停 |
| 2 | Kindle 收件地址 `kindle_email` 已固化到本地配置 | `check`（脱敏显示）或读 `~/.workbuddy/zlibrary/config.local.json` | 见 7A-0.1，**能代读就代读** |
| 3 | Agent Mail 发件地址已在亚马逊「已批准的个人文档电子邮件发送列表」 | CDP 读 pdoc 页，看正文是否出现 `agent_mail_sender` | **只能用户手动添加**，见 7A-0.2 |

**7A-0.1 拿 Kindle 收件地址（优先自动读，别让用户抄）**

用 CDP 打开 `https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc`，`/eval` 抓 `/[A-Za-z0-9._%+-]+@kindle\.com/i`，拿到后 `setup --kindle-email <它>` 写入本地配置。
取不到（未登录 / 页面改版）再让用户手抄，话术见上文「给『别人用这个 skill』的引导话术」。

**7A-0.2 白名单引导（唯一必须用户亲自动手的一步）**

- **先自动查，能省则省**：同一 pdoc 页面上若正文已出现 `agent_mail_sender`，说明早就放行过 → **直接进 7A，不要打扰用户**。
- **没出现时**，先用下列模板向用户说明并**停下来等回复**：

  > 我需要用 `<发件地址>`（脱敏显示）给你投书到 Kindle，但亚马逊只接收白名单里的发件人。
  > 请做一次设置（**一次性，之后长期有效**）：
  > 亚马逊 → 管理你的内容和设备 → 偏好设置 → 个人文档设置 → 「已批准的个人文档电子邮件发送列表」→ 添加 `<发件地址>`。
  > 加好后回我一声，我立刻投书。
  > 如果你不想做这一步，我也可以改用「Send to Kindle 网页投送」代替——效果一样，只是每次要多在网页上确认一次设备。

- 用户回复后的分支：
  - **配置完成** → 重新查白名单确认已放行 → 进 7A。
  - **明确拒绝** → 记下"用户拒绝配置"这一事实，切 7B，并在汇报中说明。
  - **没回** → 继续等，不降级。

#### 7A. 邮件投送（默认路径，≤ 5.25MB）

前置：**Agent Mail 连接器已开通**（用户侧开通，非 skill 负责）且 7A-0 三项已通过。

1. 收件地址从本地配置 `kindle_email` 取（`setup` 时已固化，见上文引导）；没有就先补。
   - 替代法：CDP 打开 `https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc`，`/eval` 抓 `/[A-Za-z0-9._%+-]+@kindle\.com/i`。
2. **确认发件地址已在亚马逊白名单**：同一页面上若正文出现 `agent_mail_sender`，说明已放行；没出现就提醒用户手动添加（这一步 skill 无法代劳）。
3. 上传附件拿 file_id：`agent_mail_upload_attachment`（路径用绝对路径）。
4. 发信（`to` 是**对象数组**，附件用 **`file_refs`** 传 file_id，**不是 `attachments`**）：
   ```
   SendMessage({
     to: [{ email: "<本地配置的 kindle_email>" }],
     subject: "<书名>",
     body: "<书名>，投送至 Kindle。",   // 正文不能为空，留空会报错
     file_refs: [{ file_id: "<file_id>" }]
   })
   ```
5. 会返回 `CONFIRMATION_REQUIRED` + `confirmation_token` → 先向用户展示 operation_summary（发件人／收件人／主题／附件数四行表格）并**明确请求确认**，得到同意后带 `confirmation_token` 重发。
   - **令牌有效期只有约 5 分钟**（看 `expires_at`），且每次调用都会刷新一个新令牌。若用户回复慢导致过期，重新发一次不带 token 的请求拿新令牌即可，别卡在旧令牌上重试。
6. 返回 `queued:true` 即成功。**最后一定要核验**：`ListMessages {dir:"sent", limit:3}` 确认该封邮件的 `to` / `subject` / `has_attachments:true` 都在，再提示用户 Kindle 联网后稍候自动同步。
   - ⚠️ **上传路径的真实体积上限约 5.25MB，不是 `GetMe` 宣称的 20MB**（2026-09-16 实测二分定位：5.0MB 通过，5.5MB 失败，报 `400 Validation failed on field: xmail.UploadFileReq.content`）。推测是上传接口对 base64 内容设了 7MB 上限（7MB×3/4 = 5.25MB）。
     - 判定方法：`agent_mail_upload_attachment` 一把过；报 `Validation failed on field: xmail.UploadFileReq.content` 即超限，**换网页投送，别反复重试**。
     - 注意另一个易混错误：`blocked attachment: file extension ".bin" is not allowed` 是扩展名被拒，与体积无关。
     - 中文文件名不是问题（实测 6.25MB 中文名与 ASCII 名同样报 content 校验错），无需改名。
   - **体积分流规则**：epub ≤ 5MB → 走 7A 邮件；> 5MB → 走 7B 网页投送（限 200MB）。**这是路由硬规则的 (a) 条**，属于物理限制，不需要征求用户同意，但要在汇报里说明。不要试图压缩正文换体积。

#### 7B. 网页投送 Send to Kindle（兜底路径；限 200MB）

**准入检查（进入前自检，说得出是哪一条才准进）**：
- (a) 文件 > 5.25MB → 邮件上传上限，物理不可行；或
- (b) **用户已明确表示不愿配置**亚马逊收件地址/发件白名单。

**不满足上述任一条就不许走 7B**——尤其不能因为"网页投送少一次用户交互"而默认选它。用户沉默时回到 7A-0.2 继续等。

1. 仅 epub/pdf/doc/docx/txt（≤200MB）；**mobi/azw3 禁止网页上传**。
2. CDP 新建 tab：`https://www.amazon.com/sendtokindle`，`/eval` 判登录态。
3. **页面没有 `<input type=file>`**，用 `stk-drop.mjs` 分块 base64 注入 + 模拟 drop：
   ```bash
   node "<skill_dir>/scripts/stk-drop.mjs" <targetId> <文件绝对路径> [文件名]
   ```
   （页面内 `fetch` 本地文件会被浏览器代理拦，只能用注入方式。）
4. **拖放目标必须先确认**。2026-09 版页面真实拖放区是 `#s2k-dnd-area`（class `s2k-dnd-box`）。
   - ⚠️ **旧版脚本的选择器 `[class*=s2k-dnd]` 会误命中 `.s2k-dnd-hero-image`（装饰大图）**，drop 打空却仍返回 `"dropped ..."`——典型静默失败。已在 `stk-drop.mjs` 修成 `#s2k-dnd-area → .s2k-dnd-box → .stk-dnd-home-functioning-area → .s2k-wrapper` 的优先级链，并把返回值改成带目标 id/class（便于肉眼核验）。
   - **判定成功的标志**：`.stk-dnd-home-functioning-area` 文本从 `Drag and drop files here` 变为 `Ready to Send | <文件名> | <体积>`。只看到 `"dropped"` 不代表成功。
5. 点 `#s2k-r2s-send-button`（Send）。成功后同一区域出现 `Your files are on the way`，右下「Recently sent files」新增一行 `<书名> | Send-to-Kindle for Web | Processing`。
   - **轮询不要把整段文本做 `includes("In library")` 匹配**——列表里历史条目也含该词，会假阳性。要按行取：`[...document.querySelectorAll("table tr")]` 常常取不到（该列表不是 table），稳妥做法是截取 `Just now` 之后的 120 字符再判断。
6. 等该行从 `Processing` → `In library`（约 1–2 分钟），书即进入 **Docs 库**。
7. **再做 Deliver to device**，确保推到具体设备：
   - 打开 `https://www.amazon.com/hz/mycd/digital-console/contentlist/pdocs/dateDsc/`（从内容页点 **Docs → See N Title(s)** 也能进；直接访问 `.../contentlist/docs` 会被重定向到 `allcontent`）。
   - 每本书的操作是 `<div class="action_button" id="<随机串>">Deliver to device</div>`。**`/click`（JS el.click()）点不动它**，要用 `/clickAt`（真鼠标事件）。
   - 弹窗是**原生 `<dialog>`**，不在 iframe/shadow DOM 里，直接 `document.querySelectorAll("dialog[open]")` 可取；用 `innerText.includes("<书名>")` 定位到本书那个 dialog，**别用 id 反查**（同一个 row button 与 dialog 的 id 前缀不同，如 row 是 `b4btlhxs`、dialog 是 `pjt1ukcn`）。
   - 复选框：`input` 带 `tabindex="-1" aria-hidden="true"`，**点 input 无效**。要点它的视觉替身 `span#<listId>_0_checkmark`（`role="checkbox"`）。核验 `aria-checked === "true"`。
   - 确认按钮是 dialog 内的 `<随机串>_CONFIRM`。成功标志：弹窗变 `Request submitted — Request to deliver <书名> has been sent`。
   - 多本批量时每个 dialog 的 id 都不同，必须逐本按书名定位。
8. 卡住时的排查顺序：拿不到 dialog → 先 `/screenshot` 看真实画面（DOM 查询常因未 attach 的 dialog 而漏判）；确认无误但状态没变 → 刷新页面重读。

> 网络请求全程由页面自身发起；Chrome 后台标签的定时器节流**不影响**这里的同步事件处理，所以无需切前台（微信读书上传则相反，见步骤 6 的 49% 限流坑）。

### 步骤 8：验证

- 微信读书：书架出现书名 = 成功。
- Kindle 邮件投送：用户 Kindle 上确认为准（云端无法直接观测，如实说明；但 sent 目录 + 附件可核验已发出）。
- Kindle 网页投送：`docsAll` 列表出现书名，且完成 Deliver to device。

---

## 脚本清单与定位

| 脚本 | 定位 |
|------|------|
| `zlib-cdp.mjs` | **主入口**。check / setup / login / import-app / search / download，全部经浏览器后台标签页完成 |
| `verify-ebook.mjs` | 上传前校验文件格式与完整性 |
| `stk-drop.mjs` | Send to Kindle 网页投送的 drop 注入 |
| `zlib-browser-dl.mjs` | **兜底**。CDP 代理不可用时用 Playwright 下载：优先 `channel:'chrome'`，无 Chrome 则回退到 **Playwright 自带 Chromium**（所以机器上没装 Chromium 系浏览器时它仍可用）。`headless:false`——**会弹窗口抢焦点**，非必要不用 |

---

## 常见故障速查

| 现象 | 处理 |
|------|------|
| `check` 报 CDP 代理未就绪 | 先跑 web-access 的 `check-deps.mjs`（可加 `--browser <chrome\|edge\|chromium\|chrome-canary>`） |
| `check` 报凭据缺失 | `login`（浏览器登录）或 `import-app`（已装 APP） |
| 用户只有 Safari / Firefox | **无解，别硬试**。Safari 是 WebDriver、Firefox 是 BiDi，都没有 CDP 端点。引导用户装 Edge/Chrome（均免费），或对「下载」环节退到 `zlib-browser-dl.mjs`（用 Playwright 自带 Chromium，但要弹窗）；微信读书导入与 Kindle 网页投送只能等用户装浏览器 |
| `check-deps` 报 `browser: needs decision / ambiguous` | `config.env` 里 `WEB_ACCESS_BROWSER` 为空，需先问用户选哪个作默认，再写入该配置项（否则每次都要问） |
| 检测不到已装的 Chromium 系浏览器 | 绝大多数是**没开远程调试开关**，不是没装。让用户访问 `chrome://inspect/#remote-debugging` 勾选 "Allow remote debugging for this browser instance" |
| Node/curl 访问镜像根路径返回 `307 Temporary Redirect` + `DiamWall` | 反爬墙，Node 破不了；必须走浏览器（`zlib-cdp.mjs` 已内置） |
| 无头浏览器下载拿到 `Try again later` | 无头必被识别，不要用 headless；用后台标签页方案 |
| 直连 `ws://127.0.0.1:9222/devtools/browser` 超时 | 沙箱会拦裸 WS；改走 CDP 代理 `localhost:3456` |
| 开关明明已勾选，还是连不上 | 是**按连接生效的授权弹窗**没点，不是开关问题。特征：`9222/json/version` 返 404 空 body、代理 `/targets` 超时、`/health` 报 `connected: null`。跑 `bash ~/.workbuddy/tools/cdp-setup.sh --status` 定位 |
| 每个任务都要手点一次「允许」 | 代理被反复重启，每条新连接都要重新批准。现已是常驻守护 + 弹窗自动点击；若仍频繁出现，先看代理有没有在反复崩（`~/Library/Logs/cdp-proxy.err.log`） |
| 装守护时报 `Bootstrap failed: 5: Input/output error` | `launchctl bootstrap` 要求处于 Aqua 登录会话。**必须在真实 Terminal 里**跑 `~/.workbuddy/tools/cdp-setup.sh`；从 AI 助手的脚本沙箱里调用一定失败（连 `/bin/date` 最小 agent 也一样） |
| 弹窗守护装了但没点 | 辅助功能权限没给。给 `/usr/bin/osascript` 授权即可（**不需要**给 `/bin/bash`，入口刻意设成 osascript 就是为收窄授权面）。改完 `launchctl kickstart -k gui/$(id -u)/com.damon.cdp-allow-dialog` |
| 域名页显示 `Suspected Phishing` | 该域被 Cloudflare 标记，**不要用**（如 `z-library.ec`）；脚本已剔除，只在候选表里手动加回过才可能遇到 |
| 下载 90s 超时且目录无新文件 | 大概率 Chrome 开了「下载前询问保存位置」，去 `chrome://settings/downloads` 关掉 |
| 下载目录不是 `~/Downloads` | 脚本会自动读 Chrome `Preferences.download.default_directory`；也可 `setup --download-dir` 指定 |
| 同名书 20 个版本不知选哪个 | 拆包比正文字数 + 看末章结尾 + `file` 看封面 EXIF，避开带公众号广告的「精排」本 |
| 微信读书上传卡 49% | 切前台标签重试 |
| 微信读书上传：`/click` 传选择器没用 | 上传框是 `input[type=file]`，用 `/setFiles`（POST body `{"selector":"input[type=file]","files":["绝对路径"]}`），不是 `/click` |
| Send to Kindle 找不到文件输入框 | 用 `stk-drop.mjs` 注入 drop；**真实目标 `#s2k-dnd-area`**，脚本返回 `no-zone` 或 drop 后页面仍显示 `Drag and drop files here` 都是失败 |
| `stk-drop.mjs` 返回 dropped 但页面无反应 | 旧选择器命中 `.s2k-dnd-hero-image` 装饰图所致，已修；确认返回值里带 `#s2k-dnd-area` |
| 判定 Send 后是否入库时误报成功 | 别对整段文本 `includes("In library")`（历史条目会命中），按行/按 `Just now` 后窗口判断 |
| `Deliver to device` 按钮 el.click() 点不动 | 该按钮是 React `<div class="action_button">`，必须用 `/clickAt` 发真鼠标事件 |
| 投送弹窗里勾了设备但没生效 | `input[type=checkbox]` 是 `aria-hidden`，要点 `span#<listId>_0_checkmark`；勾选后核验 `aria-checked==="true"` |
| mycd 页面找不到书 | 直接访问 `.../contentlist/docs` 会跳 `allcontent`；用 `.../contentlist/pdocs/dateDsc/` |
| 邮件投送被拒收 | 发件地址未加入亚马逊「已批准的个人文档电子邮件发送列表」 |
| 想抄近路直接用网页投送 | 违反投送路由硬规则。只有 `>5.25MB` 或**用户明确拒绝配置**才允许；先做 7A-0 引导 |
| 引导用户配置后用户没回 | **停下等待**，不得自行降级。用户沉默 ≠ 拒绝；沉默时也别说"那我用网页投送吧" |
| 用户拒绝了配置，下次还要问吗 | 不用重问。但要在汇报里提醒：以后想走邮件只需补一次白名单设置 |
| `agent_mail_upload_attachment` 报 `Validation failed ... UploadFileReq.content` | 附件超过上传真实上限 ~5.25MB，改走 7B 网页投送（或换更小体积的版本） |
| `agent_mail_upload_attachment` 报 `blocked attachment: file extension` | 扩展名不在白名单（如 `.bin`），与体积无关 |
| `SendMessage` 报 schema 错 | `to` 必须是 `[{email}]` 数组，附件用 `file_refs` |
| 邮件正文空报错 | 正文不能为空，加占位文字 |
| 确认令牌失效 | 令牌约 5 分钟过期；重发一次不带 token 的请求取新令牌 |

---

## 安全与交互规则

- **私有信息只落本机**：Kindle 收件地址、Agent Mail 发件地址、z-library 凭据一律只写 `~/.workbuddy/zlibrary/config.local.json`（600/700）。**禁止**写入 SKILL.md、脚本、日志或对话回显；`check` 与 `setup` 输出一律脱敏。
- **不要把 skill 目录里的任何文件改成含真实邮箱/凭据**——这个目录会被同步到 GitHub。
- 不替用户输任何密码/验证码/passkey；登录墙一律引导用户自己完成（`login` 只负责轮询抓取，不碰输入）。
- cookie 注入是写进用户自己的浏览器、用户自己的账号，属于正常登录态；`login` 抓取同理。不做任何形式的凭据外传。
- **投送方式不得静默降级**：Kindle 默认走邮件投送；**禁止**因为"网页投送不需要用户配置"就绕过 7A-0 的引导直接选网页。降级只有两条合法理由（体积 >5.25MB、用户明确拒绝配置），且必须在汇报里说明理由。用户不回应时**等待**，不要替他做决定。
- **引导配置要一次说清、只说一遍**：把「做什么 + 为什么 + 一次性长期有效 + 不想做的替代方案」四件事放在同一条消息里，避免反复追问消耗用户耐心。用户拒绝后不再重复劝说。
- 每次上传/投送前重核对文件名；交互后刷新页面状态，不复用过期元素。
- 任务结束用 `/close` 关闭自己创建的后台 tab，保留用户原有 tab。
- 批量 ≤5 本/批，控制反爬节奏。
