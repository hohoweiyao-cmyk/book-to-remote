---
name: zlibrary-to-weread-kindle-wechatreader
description: 从 Z-Library 找书、静默下载 epub，再导入微信读书（WeRead）与 Kindle。不需要安装 Z-Library.app，不弹浏览器窗口、不抢本机焦点。触发词：zlibrary 下载、z-library 找书、下载电子书导入微信读书、传到 Kindle、send to kindle、导入 kindle、weread 导入、邮件投送 kindle。
agent_created: true
---

# Z-Library 下载 → 微信读书 / Kindle 导入

**搜书下载 → 文件验证 → 微信读书导入 → Kindle 导入（邮件投送 / 网页投送二选一）。**

## 架构要点（2026-09-16 重构，先看这段）

| 问题 | 结论 |
|------|------|
| 需要 Z-Library.app 吗？ | **不需要**。APP 的唯一作用只是「存凭据」。现在凭据由本地私有配置持有，来源可以是浏览器登录（`login`）或从已装的 APP 导入（`import-app`）。 |
| 下载为什么要用浏览器？ | z-library 的 `/dl` 有 JS 反爬盾，curl 与无头浏览器都过不去（实测 headless 全部拿到 `Try again later`）。**必须真实浏览器环境**。 |
| 会弹窗抢本机使用吗？ | **不会**。不再新开浏览器，而是复用用户已开启调试端口的 Chrome，用 `background: true` 的**后台标签页**完成搜索与下载。 |
| 用哪个域名？ | 只用官方客户端下发的权威域名（首选 `z-lib.sk`）。**已剔除 `z-library.ec`**——该域被 Cloudflare 标记为 `Suspected Phishing`。 |
| 对浏览器有什么要求？ | **必须是 Chromium 系**（Chrome / Edge / Chromium）**且已手动开启远程调试**。Safari 与 Firefox 不支持，见下方「浏览器前置条件」——这是新环境最容易卡住的一关。 |

---

## 浏览器前置条件（换新环境前必查）

本 skill 所有浏览器交互都经 `web-access` 的 CDP 代理（`localhost:3456`），因此有两条**硬要求**：

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
SKILL=/Users/<你>/.workbuddy/skills/zlibrary-to-weread-kindle-wechatreader

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

### 步骤 7：导入 Kindle —— 二选一

#### 7A. 邮件投送（推荐，最省事、最稳）

前置：**Agent Mail 连接器已开通**（用户侧开通，非 skill 负责）。

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
   - 附件上限 20MB（`GetMe` 的 `max_attachment_size_bytes`），epub 通常远远够用；超限才退到网页投送。

#### 7B. 网页投送 Send to Kindle（CDP）

1. 仅 epub/pdf/doc/docx/txt（≤200MB）；**mobi/azw3 禁止网页上传**。
2. CDP 新建 tab：`https://www.amazon.com/sendtokindle`，`/eval` 判登录态。
3. **页面没有 `<input type=file>`**，用 `stk-drop.mjs` 分块 base64 注入 + 模拟 drop：
   ```bash
   node "<skill_dir>/scripts/stk-drop.mjs" <targetId> <文件绝对路径> [文件名]
   ```
   （页面内 `fetch` 本地文件会被浏览器代理拦，只能用注入方式。）
4. 文件注入后设备选择区才出现；若 "No devices found" → 去 `https://www.amazon.com/hz/mycd/digital-console/devicelist` 确认有 Kindle，再回上传页重注入。
5. 发送后书只进 **Docs 库**，还需对每本点 **Deliver to device → 勾选设备复选框 → Make Changes**。**漏勾设备复选框会静默不生效**。
6. 投递后 "In 1 Device" 标签延迟刷新，刷新页面再确认。

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
| 域名页显示 `Suspected Phishing` | 该域被 Cloudflare 标记，**不要用**（如 `z-library.ec`）；脚本已剔除，只在候选表里手动加回过才可能遇到 |
| 下载 90s 超时且目录无新文件 | 大概率 Chrome 开了「下载前询问保存位置」，去 `chrome://settings/downloads` 关掉 |
| 下载目录不是 `~/Downloads` | 脚本会自动读 Chrome `Preferences.download.default_directory`；也可 `setup --download-dir` 指定 |
| 同名书 20 个版本不知选哪个 | 拆包比正文字数 + 看末章结尾 + `file` 看封面 EXIF，避开带公众号广告的「精排」本 |
| 微信读书上传卡 49% | 切前台标签重试 |
| Send to Kindle 找不到文件输入框 | 用 `stk-drop.mjs` 注入 drop |
| Send to Kindle 显示 No devices | 内容管理页确认有 Kindle 后重注入 |
| Kindle 投递后设备无书 | 未 Deliver to device 或漏勾设备复选框 |
| 邮件投送被拒收 | 发件地址未加入亚马逊「已批准的个人文档电子邮件发送列表」 |
| `SendMessage` 报 schema 错 | `to` 必须是 `[{email}]` 数组，附件用 `file_refs` |
| 邮件正文空报错 | 正文不能为空，加占位文字 |
| 确认令牌失效 | 令牌约 5 分钟过期；重发一次不带 token 的请求取新令牌 |

---

## 安全与交互规则

- **私有信息只落本机**：Kindle 收件地址、Agent Mail 发件地址、z-library 凭据一律只写 `~/.workbuddy/zlibrary/config.local.json`（600/700）。**禁止**写入 SKILL.md、脚本、日志或对话回显；`check` 与 `setup` 输出一律脱敏。
- **不要把 skill 目录里的任何文件改成含真实邮箱/凭据**——这个目录会被同步到 GitHub。
- 不替用户输任何密码/验证码/passkey；登录墙一律引导用户自己完成（`login` 只负责轮询抓取，不碰输入）。
- cookie 注入是写进用户自己的浏览器、用户自己的账号，属于正常登录态；`login` 抓取同理。不做任何形式的凭据外传。
- 每次上传/投送前重核对文件名；交互后刷新页面状态，不复用过期元素。
- 任务结束用 `/close` 关闭自己创建的后台 tab，保留用户原有 tab。
- 批量 ≤5 本/批，控制反爬节奏。
