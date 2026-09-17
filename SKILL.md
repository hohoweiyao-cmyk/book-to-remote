---
name: book-to-remote
description: 从 Z-Library 找书、静默下载 epub，再导入微信读书（WeRead）与 Kindle。不需要安装 Z-Library.app，不需要开浏览器调试开关、不需要任何系统授权、不弹窗、不抢焦点——首次部署一次后全程零点击自动跑完。触发词：book-to-remote、zlibrary 下载、z-library 找书、下载电子书导入微信读书、传到 Kindle、send to kindle、导入 kindle、weread 导入、邮件投送 kindle。
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
| 下载为什么要用浏览器？ | z-library 的 `/dl` 有 JS 反爬盾，curl 与无头浏览器都过不去（实测 headless 拿到 `Access Denied` / `Try again later`）。**必须真实有头浏览器环境**。 |
| 会弹窗抢本机使用吗？ | **不会**。专用 Chrome 实例用 `--no-startup-window` 启动（启动即零窗口），所有标签页用 `background: true` 创建，不抢焦点。 |
| 用哪个域名？ | 只用官方客户端下发的权威域名（首选 `z-lib.sk`）。**已剔除 `z-library.ec`**——该域被 Cloudflare 标记为 `Suspected Phishing`。 |
| 需要用户做什么？ | **只要机器上有任一 Chromium 系浏览器**。不用开任何开关、不用给系统权限、不用点任何弹窗。一次性 `cdp.mjs bootstrap` 之后全自动——见下方「浏览器方案」。 |
| Kindle 走邮件还是网页投送？ | **默认邮件（7A）**。邮件走不通时先**引导用户完成亚马逊配置（7A-0）**，而不是直接降级。**仅两种情况**才用网页投送：① 文件 > 5.25MB（邮件上传实测上限）；② 用户**明确拒绝**配置。用户沉默 ≠ 拒绝，须等待。详见步骤 7 的「投送路由硬规则」。 |

---

## 浏览器方案：专用 Chrome 实例（零授权、零点击）

本 skill **不依赖 `web-access` 的 CDP 代理**，自带浏览器层 `scripts/cdp.mjs`，走 Chrome 官方推荐的
「专用 profile + `--remote-debugging-port`」路径 —— **结构性无授权弹窗、无需任何系统权限。**

**一次性部署**（只做一次，之后全自动）：

```bash
SKILL=~/.workbuddy/skills/book-to-remote
node "$SKILL/scripts/cdp.mjs" bootstrap
```

它会：建专用 profile → 从日常 Chrome 迁移登录态 → 拉起实例 → 核验三个站点登录态。

| 问题 | 结论 |
|------|------|
| 要开 `chrome://inspect` 的开关吗？ | **不用**。那个开关只对「连日常 Chrome」有意义，本方案完全不碰 |
| 要授权「辅助功能」吗？ | **不用**。不装守护进程、不做任何系统授权 |
| 会弹「要允许远程调试吗？」吗？ | **不会**。专用 profile 是官方认证的无弹窗路径 |
| 会抢焦点 / 冒出窗口吗？ | **不会**。实例用 `--no-startup-window` 启动（启动即零窗口），标签页用 `background: true` 创建 |
| 会影响用户日常用的 Chrome 吗？ | **不会**。不同 `--user-data-dir` = 两个互不干扰的进程，可并存 |

### 为什么不用「自动点弹窗」绕过去

连接**用户日常 Chrome** 时，Chrome 会对**每一条新建的 WebSocket 连接**弹一次「要允许远程调试吗？」，
且明确拒绝持久化。官方在 `ChromeDevTools/chrome-devtools-mcp#825` 的回复（已 close as *not planned*）：

> There is no simple solution that also would not allow any program on the machine to easily access your data in Chrome.
> For now, we recommend to **have longer connection sessions** to avoid the reconnect dialog.

理由站得住：能持久化的话，本机任何程序都能静默读走 Cookie 与密码库。
用「辅助功能权限 + AppleScript 自动点允许」确实能绕过去，但那**本身就要用户做一次系统授权**，
不满足「全程零授权」——所以本 skill 不走这条路。

### 四条硬约束（改 `cdp.mjs` 前必读，都是实测结论）

| 约束 | 原因 |
|------|------|
| **必须带非默认 `--user-data-dir`** | Chrome 136+ 起 `--remote-debugging-port` 在**默认 profile 上被完全忽略**。这是官方反 cookie 窃取设计，无 flag / policy 可绕。**「真实默认 profile」与「可 CDP 控制」自 136 起互斥。** |
| **必须 `--no-startup-window`** | 启动时不创建任何窗口 → 用户完全无感。少了它每次拉起都会闪一个窗口 |
| **不能用无头模式** | `--headless=new` 会被 Z-Library 的 DiamWall 直接判成 `Access Denied`。必须是有头浏览器 |
| **窗口不能靠 CDP 最小化** | `Browser.setWindowBounds({windowState:'minimized'})` 在 macOS 无效；只能把 `left` 推到屏外 |

### 登录态从哪来

专用 profile 本身是干净的，登录态靠**迁移 cookies**：

- **时机**：只在实例**未运行**时同步（Chrome 退出时会回写 Cookies，边跑边覆盖会互相冲掉）
- **来源**：`~/Library/Application Support/Google/Chrome/<profile>/Cookies`，脚本自动挑 Cookie 库最大的那个 profile
- **为什么能用**：macOS 上 cookies 由 Keychain 的 `Chrome Safe Storage` 加密，该密钥**按应用下发而非按 profile**，所以同机同应用换个 profile 仍能解密
- **自愈**：`ensureBrowser()` 每次拉起实例前都会重同步。只要日常 Chrome 里还登着，就不用管

**真要手动登录时**（用户在日常 Chrome 登出了、或换了账号）：

```bash
node "$SKILL/scripts/cdp.mjs" new "https://z-lib.sk/"   # 开一个窗口，用鼠标登录
```

注意这是**专用实例的窗口**，不是用户日常那个 Chrome。登录完关掉标签页即可。

> 唯一无法自动化的一环：用户在**日常 Chrome** 里主动登出这些站点 → 迁移来的会话失效。
> 此时让用户重新登录日常 Chrome，或按上面的方式在专用实例里登一次。

### 另需注意

- **日常 Chrome 那个开关对本 skill 已无用**。`chrome://inspect/#remote-debugging` 与 9222 端口一律不碰。留着不影响运行（别的工具可能还在用），但要清楚它和本方案无关。
- **端侧模型要关掉**。启动参数里带了 `--disable-features=OptimizationGuideOnDeviceModel,OptimizationGuideModelDownloading,...`；不加的话 Chrome 会后台偷下端侧模型，实测 `OptGuideOnDeviceModel` 单目录吃到 **4.0G**。`node cdp.mjs prune` 可清理这类可再生缓存。
- **换浏览器**：改 `~/.workbuddy/chrome-cdp/config.local.json` 的 `chrome_bin` 即可（任何 Chromium 系都行，不要求是用户的日常浏览器）。
- **改端口**：同文件的 `port`，默认 `9444`（刻意避开 9222，避免和用户日常 Chrome 抢端口）。
- **`cdp.mjs` 的每个业务子命令都会自动拉起实例**（`new` / `eval` / `nav` / `cookies` / `click` / `clickat` / `shot` / `setfiles` / `close` / `tabs`），冷机状态下直接敲就行，不必先 `ensure`。只有管理实例本身的命令不自动拉起：`check` / `bootstrap` / `ensure` / `sync-cookies` / `prune` / `kill`。
- **`sync-cookies` 与 `prune` 必须先 `kill`**：实例运行时会回写 Cookies、并锁住缓存目录，边跑边覆盖等于白做。脚本会直接拒绝并提示。`zlib-cdp.mjs` 的自动拉起里已内置这两个动作，所以日常路径碰不到这个坑。
- **需要用户亲自操作时（登录 / 过验证码）**：`cdp.mjs show <target>` 把窗口挪回屏幕内并置顶（`new` 建的是后台标签、窗口默认在屏外）。**用户操作期间的所有 `cdp.mjs` 调用都要加 `CDP_NO_HIDE=1`**，否则自动隐藏会把用户正在填的窗口又挪走：
  ```bash
  T=$(node "$SKILL/scripts/cdp.mjs" new "<登录页>")
  node "$SKILL/scripts/cdp.mjs" show "$T"          # 弹出可见窗口，交给用户
  CDP_NO_HIDE=1 node "$SKILL/scripts/cdp.mjs" eval "$T" '<判登录态>'   # 期间轮询都要带这个前缀
  ```
  用户操作完，关掉标签即可；下一个自动化命令会照常把窗口移回屏外。`front <target>` 是更轻的版本（只切前台、不改位置），用于后台限速卡住的兜底。

### 已废弃：常驻代理 + 弹窗自动点击（2026-09-17 弃用，勿重做）

上一版曾用「CDP 代理常驻 + AppleScript 每 3s 扫弹窗自动点允许」来解决重复授权。**已废弃** ——
它要求用户给 `/usr/bin/osascript` 开辅助功能权限，**那本身就是一次系统授权**，与「全程零授权」冲突。

相关的两个 LaunchAgent（`com.damon.cdp-proxy`、`com.damon.cdp-allow-dialog`）和脚本
（`~/.workbuddy/tools/cdp-*.sh`）都不再需要。**plist 一定要移除**，否则下次登录 macOS 会自动加载
并触发权限提示。留档两条教训：

1. `launchctl bootstrap gui/<uid>` 要求调用方处于 Aqua 登录会话；从 AI 助手的脚本沙箱调用会稳定报
   `Bootstrap failed: 5: Input/output error` —— 连 `/bin/date` 这种最小 agent 也一样，不是 plist 写错了。
2. macOS 辅助功能（TCC）按「主可执行文件」判定归属。真要做 UI 自动化，入口设成 `/usr/bin/osascript`
   比包一层 `/bin/bash` 安全得多（后者等于把 bash 加进辅助功能，任何脚本都能驱动 UI）。

### 如果用户机器上只有 Safari / Firefox

**不再是障碍了。** 新方案只需要机器上**存在**任一 Chromium 系浏览器，**不要求它是用户的日常浏览器** ——
专用实例是独立进程、独立 profile，从不碰用户的浏览数据。

按优先级：

| 方案 | 做法 | 弹窗 / 抢焦点 |
|------|------|--------------|
| 装任一 Chromium 系 | Chrome / Chromium / Edge，装上即可，**无需任何开关** | 无 |
| 指定现成的 Chromium | 在 `~/.workbuddy/chrome-cdp/config.local.json` 填 `chrome_bin` 指向 Chrome for Testing、Playwright 自带的 Chromium 等 | 无 |
| 兜底：Playwright | `zlib-browser-dl.mjs`，用 Playwright 自带 Chromium 下载 | ⚠️ `headless:false` 会抢焦点，非必要不用 |

即使只有 Safari / Firefox，Kindle 邮件投送与 epub 校验这两步也与浏览器无关，照常可用。

---

## 快速开始（新用户照这个顺序走）

```bash
SKILL=~/.workbuddy/skills/book-to-remote

# 0) 一次性部署浏览器层：建专用 profile + 迁登录态 + 拉起实例 + 核验三站点
#    之后每轮任务会自动拉起实例并重同步登录态，无需再管
node "$SKILL/scripts/cdp.mjs" bootstrap

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
   - ⚠️ 这一条要在 `/hz/mycd/*` 页面上核验，而亚马逊对该路径**会周期性强制重登**。遇到跳登录页时按「常见故障速查」那一行的办法处理，**别把它当成 cookie 迁移失败**。
3. 体积 >5.25MB 或用户明确拒绝配置时，才切 7B 网页投送。

> **亚马逊与另两个站点的差别（2026-09-17 实测）**：Z-Library 与微信读书的登录态靠 cookie 迁移就能长期稳定；
> 亚马逊除了 cookie 轮转（`session-token`/`at-main`）还会对账号页强制重登，所以它**是唯一可能需要用户
> 偶尔登录一次**的站点。想彻底省掉，就让用户在**专用实例**里独立登录一次亚马逊。

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
   - 不想让用户手抄时，可用 CDP 直接读（命令见 7A-0.1）：
     ```bash
     T=$(node "<skill_dir>/scripts/cdp.mjs" new "https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc")
     node "<skill_dir>/scripts/cdp.mjs" eval "$T" 'JSON.stringify((document.body.innerText.match(/[A-Za-z0-9._%+-]+@kindle\.com/i)||[""])[0])'
     node "<skill_dir>/scripts/cdp.mjs" close "$T"
     ```
2. **发件地址**——先调 Agent Mail 的 `GetMe` 拿主别名，然后**明确告知用户**：
   > "我会用 `<发件地址>` 给你投书。请把它加入亚马逊『已批准的个人文档电子邮件发送列表』，否则亚马逊会直接拒收。"
   - 这个白名单动作**只能用户手动做**，skill 无法代劳。
   - 可顺手在同一个亚马逊页面上 `grep` 一遍：若正文里已出现该发件地址，说明早就放行过，不用再折腾用户。
3. **写入本地**——`setup --kindle-email ... --sender ...`，然后用 `check` 复核（`check` 只显示脱敏值）。

---

## 工作流

### 步骤 1：环境自检

```bash
node "<skill_dir>/scripts/cdp.mjs" check     # 浏览器层：实例 / profile / 端口 / 登录态来源
node "<skill_dir>/scripts/zlib-cdp.mjs" check # 业务层：凭据 / 本地配置 / Kindle 地址 / 下载目录
```

输出会明确给出缺什么、下一步敲什么。**实例没跑不用管** —— `zlib-cdp.mjs` 的每个子命令都会自动
`ensureBrowser()`（同步登录态 + 拉起实例 + 移走窗口），不需要先手动启动。

### 步骤 2：取凭据

- `login`：在**专用实例**里开一个标签页到 z-library，用户在那个窗口登录一次，脚本轮询 `document.cookie` 抓到 `remix_userid/remix_userkey` 后落盘。**这是不用装 APP 的主路径。**
  > 注意：是专用实例的窗口，不是用户日常那个 Chrome，提示用户时要说清楚。
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

### 步骤 6：导入微信读书

实例没跑会自动拉起，标签页建在后台、不抢焦点：

```bash
SKILL=~/.workbuddy/skills/book-to-remote
node "$SKILL/scripts/cdp.mjs" ensure                                  # 可省：new 也会自动拉起
T=$(node "$SKILL/scripts/cdp.mjs" new "https://weread.qq.com/web/upload")   # 直达上传页，别找书架弹窗

# 判登录态（wr_vid 是 httpOnly，只能用 CDP 读，document.cookie 看不到）
node "$SKILL/scripts/cdp.mjs" cookies "$T" "https://weread.qq.com"

# 塞文件，绕过文件对话框（上传页只有一个 input[type=file]）
node "$SKILL/scripts/cdp.mjs" setfiles "$T" 'input[type=file]' "/绝对路径/书名.epub"

node "$SKILL/scripts/cdp.mjs" close "$T"
```

1. 上传页只需认「导入完成」；但**必须以书架出现书名才算成功**（导航到 `/web/shelf` 再查一次，别只看上传页文案）。
2. 实例启动参数已带 `--disable-background-timer-throttling` 等，**后台标签不会再被限速**，正常不会卡在 ~49%。
3. 万一仍卡住：把上传页标签切到前台几秒即可（`Page.bringToFront`，或让用户点一下）。

> 步骤 2/3/4 的等值脚本化写法：`cdp.mjs eval <target> "<表达式>"`。上传页与书架页的所有判断都可以用它。

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

```bash
T=$(node "<skill_dir>/scripts/cdp.mjs" new "https://www.amazon.com/hz/mycd/myx#/home/settings/pdoc")
node "<skill_dir>/scripts/cdp.mjs" eval "$T" 'JSON.stringify((document.body.innerText.match(/[A-Za-z0-9._%+-]+@kindle\.com/i)||[""])[0])'
node "<skill_dir>/scripts/cdp.mjs" close "$T"
```
拿到后 `setup --kindle-email <它>` 写入本地配置。取不到（未登录 / 页面改版）再让用户手抄，话术见上文「给『别人用这个 skill』的引导话术」。

> ⚠️ **先判是不是被弹去登录页**：亚马逊会周期性对 `/hz/mycd/*` 强制重登。若 `eval` 拿到的
> `document.title` 是 `Amazon Sign-In`、或 `location.href` 含 `/ap/signin`，说明**这一页进不去**——
> 此时**不要**据此判定「未登录」或「cookie 迁移失败」，更不要反复重试。正确动作：告知用户需在专用实例里
> 登录一次亚马逊（一次性），或改用本地配置里已有的 `kindle_email` 继续。

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
   - 替代法：用 `cdp.mjs new` 打开 pdoc 页，再 `cdp.mjs eval` 抓 `/[A-Za-z0-9._%+-]+@kindle\.com/i`（具体命令见 7A-0.1）。
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
2. 新建后台标签页并判登录态：
   ```bash
   T=$(node "<skill_dir>/scripts/cdp.mjs" new "https://www.amazon.com/sendtokindle")
   node "<skill_dir>/scripts/cdp.mjs" cookies "$T" "https://www.amazon.com"   # 要有 session-id / at-main
   ```
3. **页面没有 `<input type=file>`**，用 `stk-drop.mjs` 分块 base64 注入 + 模拟 drop：
   ```bash
   node "<skill_dir>/scripts/stk-drop.mjs" "$T" <文件绝对路径> [文件名]
   ```
   （该页确实没有文件输入框，所以用不了 `DOM.setFileInputFiles`。整段注入复用同一条 CDP 连接，6MB 的 epub 约十几块。）
4. **拖放目标必须先确认**。2026-09 版页面真实拖放区是 `#s2k-dnd-area`（class `s2k-dnd-box`）。
   - ⚠️ **旧版脚本的选择器 `[class*=s2k-dnd]` 会误命中 `.s2k-dnd-hero-image`（装饰大图）**，drop 打空却仍返回 `"dropped ..."`——典型静默失败。已在 `stk-drop.mjs` 修成 `#s2k-dnd-area → .s2k-dnd-box → .stk-dnd-home-functioning-area → .s2k-wrapper` 的优先级链，并把返回值改成带目标 id/class（便于肉眼核验）。
   - **判定成功的标志**：`.stk-dnd-home-functioning-area` 文本从 `Drag and drop files here` 变为 `Ready to Send | <文件名> | <体积>`。只看到 `"dropped"` 不代表成功。
5. 点 `#s2k-r2s-send-button`（Send）。成功后同一区域出现 `Your files are on the way`，右下「Recently sent files」新增一行 `<书名> | Send-to-Kindle for Web | Processing`。
   - **轮询不要把整段文本做 `includes("In library")` 匹配**——列表里历史条目也含该词，会假阳性。要按行取：`[...document.querySelectorAll("table tr")]` 常常取不到（该列表不是 table），稳妥做法是截取 `Just now` 之后的 120 字符再判断。
6. 等该行从 `Processing` → `In library`（约 1–2 分钟），书即进入 **Docs 库**。
7. **再做 Deliver to device**，确保推到具体设备：
   - 打开 `https://www.amazon.com/hz/mycd/digital-console/contentlist/pdocs/dateDsc/`（从内容页点 **Docs → See N Title(s)** 也能进；直接访问 `.../contentlist/docs` 会被重定向到 `allcontent`）。
   - 每本书的操作是 `<div class="action_button" id="<随机串>">Deliver to device</div>`。**`click`（JS el.click()）点不动它**，要用 `clickat`（派发真实 Input 鼠标事件）：
     ```bash
     node "<skill_dir>/scripts/cdp.mjs" clickat "$T" '#<action_button_id>'
     ```
   - 弹窗是**原生 `<dialog>`**，不在 iframe/shadow DOM 里，直接 `document.querySelectorAll("dialog[open]")` 可取；用 `innerText.includes("<书名>")` 定位到本书那个 dialog，**别用 id 反查**（同一个 row button 与 dialog 的 id 前缀不同，如 row 是 `b4btlhxs`、dialog 是 `pjt1ukcn`）。
   - 复选框：`input` 带 `tabindex="-1" aria-hidden="true"`，**点 input 无效**。要点它的视觉替身 `span#<listId>_0_checkmark`（`role="checkbox"`）。核验 `aria-checked === "true"`。
     ```bash
     node "<skill_dir>/scripts/cdp.mjs" clickat "$T" 'span#<listId>_0_checkmark'
     node "<skill_dir>/scripts/cdp.mjs" eval "$T" 'document.getElementById("<listId>_0_checkmark").getAttribute("aria-checked")'
     ```
   - 确认按钮是 dialog 内的 `<随机串>_CONFIRM`。成功标志：弹窗变 `Request submitted — Request to deliver <书名> has been sent`。
   - 多本批量时每个 dialog 的 id 都不同，必须逐本按书名定位。
8. 卡住时的排查顺序：拿不到 dialog → 先截图看真实画面（DOM 查询常因未 attach 的 dialog 而漏判）：
   ```bash
   node "<skill_dir>/scripts/cdp.mjs" shot "$T" /tmp/mycd.png
   ```
   确认无误但状态没变 → 刷新页面重读。

> 网络请求全程由页面自身发起。实例启动参数已关掉后台标签节流（`--disable-background-timer-throttling` 等），
> 微信读书上传与这里的异步轮询都能在后台标签全速跑完，不需要把标签切前台。

### 步骤 8：验证

- 微信读书：书架出现书名 = 成功。
- Kindle 邮件投送：用户 Kindle 上确认为准（云端无法直接观测，如实说明；但 sent 目录 + 附件可核验已发出）。
- Kindle 网页投送：`docsAll` 列表出现书名，且完成 Deliver to device。

---

## 脚本清单与定位

| 脚本 | 定位 |
|------|------|
| `cdp.mjs` | **浏览器层（自包含）**。实例守卫（自动拉起 / 迁移登录态 / 移走窗口 / 清理缓存）+ 直连 CDP 客户端。子命令跑 `node cdp.mjs` 查看 |
| `zlib-cdp.mjs` | **业务主入口**。check / setup / login / import-app / search / download |
| `verify-ebook.mjs` | 上传前校验文件格式与完整性 |
| `stk-drop.mjs` | Send to Kindle 网页投送的 drop 注入 |
| `zlib-browser-dl.mjs` | **兜底**。机器上完全没有任何 Chromium 时，用 Playwright 自带 Chromium 下载。`headless:false`——**会抢焦点**，非必要不用 |

---

## 常见故障速查

| 现象 | 处理 |
|------|------|
| `cdp.mjs check` 报实例未运行 | 正常。`bootstrap` 部署一次即可，之后 `zlib-cdp.mjs` 的每个子命令都会自动拉起 |
| `zlib-cdp.mjs check` 报凭据缺失 | `login`（浏览器登录）或 `import-app`（已装 APP） |
| 用户只有 Safari / Firefox | **不再是障碍**。只要机器上**存在**任一 Chromium 系浏览器即可（不要求是日常浏览器）；或在配置里用 `chrome_bin` 指向 Chrome for Testing / Playwright 的 Chromium |
| 拉起实例超时（30s） | ① 手动跑一次看报错：`"<chrome>" --user-data-dir="$HOME/.workbuddy/chrome-cdp/profile" --remote-debugging-port=9444`；② 端口被占：`lsof -nP -iTCP:9444 -sTCP:LISTEN`；③ 换端口：改 `~/.workbuddy/chrome-cdp/config.local.json` 的 `port` |
| 实例在跑但 `/json/version` 返 404 空 body | 连上的不是专用实例，而是**用户日常 Chrome**（它未获授权时不提供 HTTP 端点）。核对端口，别用 9222 |
| Node/curl 访问镜像根路径返回 `307 Temporary Redirect` + `DiamWall` | 反爬墙，Node 破不了；必须走浏览器（`zlib-cdp.mjs` 已内置） |
| 无头浏览器拿到 `Access Denied` / `Try again later` | 无头必被识别。`cdp.mjs` 刻意不传 `--headless`，别再加回去 |
| 探测本地端口得到 `502 upstream connect failed` | 环境变量 `HTTP_PROXY` 劫持了 localhost 请求。用 `env -u HTTP_PROXY ... curl`，或直接用 node fetch（node 不读这个变量） |
| 每次还要弹授权框 / 手点「允许」 | 说明走回了「连日常 Chrome」的老路。检查是否误用 9222 或第三方 CDP 代理；本 skill 只应连 9444 的专用实例 |
| 专用实例的窗口冒出来了 | 只可能是手动跑了 `cdp.mjs new`。自动化路径用 `background:true` 建标签，不会出现窗口；`cdp.mjs ensure` 会把窗口移到屏外 |
| profile 体积暴涨到几个 G | Chrome 后台偷下端侧模型（`OptGuideOnDeviceModel`，实测 **4.0G**）。启动参数已禁；`cdp.mjs prune` 清理已有缓存 |
| 域名页显示 `Suspected Phishing` | 该域被 Cloudflare 标记，**不要用**（如 `z-library.ec`）；脚本已剔除，只在候选表里手动加回过才可能遇到 |
| 下载 90s 超时且目录无新文件 | 已用 `Browser.setDownloadBehavior` 强制落盘，不再受「下载前询问保存位置」影响。仍超时则查：当日额度是否用完 / 域名是否被墙 |
| 下载目录不符合预期 | 决定顺序：配置 `download_dir` > 日常 Chrome 的 `Preferences.download.default_directory` > `~/Downloads`。**脚本与浏览器用的是同一个值**，不会出现「脚本盯 A 目录、Chrome 存到 B 目录」的错位 |
| 同名书 20 个版本不知选哪个 | 拆包比正文字数 + 看末章结尾 + `file` 看封面 EXIF，避开带公众号广告的「精排」本 |
| 微信读书上传卡 49% | 启动参数已关掉后台标签节流（`--disable-background-timer-throttling` 等），正常不会出现。仍卡则 `Page.bringToFront`，或让用户点一下 |
| 微信读书上传没反应 | 上传框是 `input[type=file]`，用 `cdp.mjs setfiles <target> 'input[type=file]' <绝对路径>`，不是 `click` |
| Send to Kindle 找不到文件输入框 | 用 `stk-drop.mjs` 注入 drop；**真实目标 `#s2k-dnd-area`**，脚本返回 `no-zone` 或 drop 后页面仍显示 `Drag and drop files here` 都是失败 |
| `stk-drop.mjs` 返回 dropped 但页面无反应 | 旧选择器命中 `.s2k-dnd-hero-image` 装饰图所致，已修；确认返回值里带 `#s2k-dnd-area` |
| 判定 Send 后是否入库时误报成功 | 别对整段文本 `includes("In library")`（历史条目会命中），按行/按 `Just now` 后窗口判断 |
| `Deliver to device` 按钮 el.click() 点不动 | 该按钮是 React `<div class="action_button">`，必须用 `cdp.mjs clickat` 派发真鼠标事件 |
| 投送弹窗里勾了设备但没生效 | `input[type=checkbox]` 是 `aria-hidden`，要点 `span#<listId>_0_checkmark`；勾选后核验 `aria-checked==="true"` |
| mycd 页面找不到书 | 直接访问 `.../contentlist/docs` 会跳 `allcontent`；用 `.../contentlist/pdocs/dateDsc/` |
| **打开 `/hz/mycd/*` 却跳到 `Amazon Sign-In`** | 亚马逊对「管理你的内容和设备」这类账号页会**周期性强制重登**——即使 `sendtokindle` 等普通页仍显示已登录（2026-09-17 实测：同一实例 `sendtokindle` 正常、`mycd` 跳登录）。判定方法：`document.title === 'Amazon Sign-In'` 或 `location.href.includes('/ap/signin')`。**这不是 cookie 迁移失败**，重跑 `sync-cookies` 也无效。处理：`cdp.mjs show <target>` 把登录页弹给用户，用户登一次即可（一次性）；期间轮询加 `CDP_NO_HIDE=1`。之后 7A-0 的 pdoc 页与 7B 的 Deliver to device 才能用 |
| `sync-cookies` 报「专用实例正在运行…已中止」 | 设计如此：实例退出时会把自己的 Cookies 回写，覆盖会白做。先 `cdp.mjs kill`，再 `sync-cookies` |
| 邮件投送被拒收 | 发件地址未加入亚马逊「已批准的个人文档电子邮件发送列表」（7A-0 第 3 项）。若 mycd 页跳登录导致无法核验，**不要假设已放行**，先把重登问题解决掉再投 |
| 亚马逊 cookie 明明没过期却仍要登录 | 复制来的 `session-token` / `at-main` 是**轮转令牌**，日常 Chrome 那边的活动会让副本失效。`sync-cookies` 能救一时；要长期稳定，就让用户在专用实例里独立登录一次 |
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
