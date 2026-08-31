---
name: zlibrary-to-weread-kindle-wechatreader
description: 调用本机 Z-Library APP 的登录凭据自动下载电子书，并导入用户微信读书（WeRead）和 Kindle 阅读器。触发词：zlibrary 下载、z-library 找书、下载电子书导入微信读书、传到 Kindle、send to kindle、导入 kindle、weread 导入、邮件投送 kindle。适用于"从 z-library 找书→下载→同步到我的阅读设备"的完整链路。
agent_created: true
---

# Z-Library 下载 → 微信读书 / Kindle 导入

一条命令打通：**Z-Library 搜书下载 → 文件验证 → 微信读书导入 → Kindle 导入（网页投送 / 邮件投送二选一）**。

## 使用前必读（给别人用时的提示）

本 skill 依赖用户本机已有的三样东西，缺一不可。开始前先逐项确认，**缺哪项就先引导用户补哪项，不要跳过直接开干**：

| # | 依赖 | 如何确认 | 缺了怎么办 |
|---|------|---------|-----------|
| 1 | **Z-Library.app 已登录** | `ls -d /Applications/Z-Library.app` 且凭据文件存在（见下） | 让用户打开 Z-Library.app 登录一次账号 |
| 2 | **代理工具已开**（z-library 被墙） | 运行 `check` 看是否有可用通道 | 让用户开 Clash/V2Ray，或 `ZLIB_PROXY=http://127.0.0.1:<port>` 指定 |
| 3 | **web-access 已加载**（CDP 连用户 Chrome） | 加载 web-access skill 走 `/check-deps` | 微信读书/亚马逊登录态复用用户浏览器，无需输密码 |

**必须向用户问清并记录的信息**（用 AskUserQuestion 一次问完，≤4 题）：
- 书名 / 作者 / ISBN（可多本，用列表）
- 目标平台：微信读书 / Kindle / 两者
- 格式：epub（默认，两端通用）/ mobi / azw3 / pdf

**私有账号配置**（使用前须向用户问清，勿在回复中回显完整值；分享/公开版本一律用占位符）：
- Kindle 专属邮箱：`<用户填自己的 Kindle 专属邮箱>`（一律小写，形如 `xxx_xxx@kindle.com`）——用于**邮件投送**。用户可在亚马逊「管理你的内容和设备 → 偏好设置 → 个人文档设置」查看。
- 默认 Kindle 设备名：`<用户填自己的设备名>`（在亚马逊设备列表里看）
- 默认下载目录：`~/Downloads`

---

## 工作流

### 步骤 1：环境自检（每轮必做）

```bash
node "<skill_dir>/scripts/zlib-download.mjs" check
```
- `exit 0` → 有可用通道，继续
- `exit 3` → 无通道，提示开代理
- 报凭据缺失 → 提示先登录 Z-Library.app

凭据文件位置：`~/Library/Application Support/z-library/config.json`，字段为 `remix_userid` / `remix_userkey` / `domains`（域名数组）/ `email`。

### 步骤 2：下载（推荐一条命令走通）

**关键结论：`download --hash` 直连已失效（被 JS 反爬挡）。直接用下面的 `zlib-browser-dl.mjs`，它内部自动完成「搜索 → 详情拿 dl 链接 → Playwright 非无头真实 Chrome 过盾下载」，一条命令出文件。**

```bash
node "<skill_dir>/scripts/zlib-browser-dl.mjs" "书名 作者" "~/Downloads/书名.epub" [epub]
```

脚本内部逻辑（无需手操作，但要知道）：
1. 域名自适应：优先 `ZLIB_DOMAIN` env → 常用域名 → config 里的 `domains`，逐个探测第一个可达的。
2. 搜索接口是 **POST**（`/eapi/book/search?message=...`，body `{count,page}`）。
3. hash 只有 6 位，需调详情接口 `/eapi/book/<id>/<hash>` 拿 `book.dl` 真实下载链接。
4. 用 Playwright **非无头** Chrome（`channel:'chrome', headless:false`）注入 `remix_userid/remix_userkey` cookie 访问 `/dl` 过 JS 盾。**无头会被识别（报 "Try again later"）。**
5. 自动 `download.saveAs` 落盘，最后校验文件大小 ≥10KB。
6. **选书排序**：标题锚精确匹配 + 作者唯一（无 `&` 合著）+ 降权「套装/合集/定律/导读/手册」类标题，避免误选套装。选中的书会在日志打印 `选定: ...`，务必核对书名/作者/大小是否符合预期。

**依赖**：Playwright + Chromium。首次使用需安装（已就绪的机器可跳过）：
```bash
cd ~/.workbuddy/binaries/node/workspace && npm install playwright && npx playwright install chromium
```
脚本已用 `createRequire` 自动从 `~/.workbuddy/binaries/node/workspace` 解析 playwright（无需 `NODE_PATH`，ESM 下它不生效）。直接用 node 运行即可：
```bash
node "<skill_dir>/scripts/zlib-browser-dl.mjs" "书名 作者" "~/Downloads/书名.epub" [epub]
```
选书逻辑：标题锚精确匹配 + 作者唯一（无 `&` 合著）+ 降权「套装/合集/定律/导读」类大杂烩标题，避免误选套装。如需指定精确版本，先 `search` 核对 hash，再用详情接口直接下。

**兜底通道**（脚本失败时）：
- 网页版 CDP：用 web-access 打开 z-library 可用域名 → 搜索 → 详情页点 Download。
- 本机 APP：`open -a "Z-Library"` 让用户手动下，skill 监控 `~/Downloads` 新文件。

### 步骤 3：验证文件（上传前必做）

```bash
node "<skill_dir>/scripts/verify-ebook.mjs" <文件路径>
```
`ok:false` → 停下报告，不继续上传。记录文件名、扩展名、大小。

### 步骤 4：导入微信读书（web-access CDP）

1. CDP 新建 tab：`POST http://localhost:3456/new` → `https://weread.qq.com/web/upload`（**直达上传页，别找书架弹窗**）。
2. `/eval` 判断登录态；未登录 → 让用户在自己浏览器扫码（一次性，之后常态化）。
3. `/eval` 找 `input[type=file]`，用 `/setFiles` 设本地路径绕过文件对话框。
4. 轮询「导入完成」/书架出现书名（超时 60s），**以书架出现书名才算成功**。

**微信读书坑（必记）**：
- Chrome 会限流后台标签，上传卡 ~49% 是**被限速不是失败**，把上传页标签切前台（或让用户点一下）几秒即传完。
- 上传超时点「重试」，前台重传很快。

### 步骤 5：导入 Kindle —— 二选一

#### 5A. 邮件投送（推荐，最省事、最稳）

前置：需 **Agent Mail 连接器已开通**（用户侧开通，非 skill 负责）。

1. **先提醒用户**：把发件邮箱（Agent Mail 的 `GetMe` 返回地址，通常形如 `xxx@agent.qq.com`）加入亚马逊「已批准的个人文档电子邮件列表」，否则会被拒收。这一步是**用户手动操作**，skill 无法代劳。
2. 上传附件拿 file_id：用 `agent_mail_upload_attachment` 上传本地 epub。
3. 发信（注意 `to` 是**对象数组**，附件用 **`file_refs`** 传 file_id，**不是 `attachments`**）：
   ```
   SendMessage({
     to: [{ email: "<用户的 Kindle 专属邮箱>" }],
     subject: "<书名>",
     body: "<书名>，投送至 Kindle。",   // 正文不能为空，留空会报错
     file_refs: [{ file_id: "<file_id>" }]
   })
   ```
4. 会返回 `CONFIRMATION_REQUIRED` + `confirmation_token` → 先向用户展示 operation_summary 并**明确请求确认**，得到同意后带 `confirmation_token` 重发。
5. 返回 `queued:true` 即成功，提示用户 Kindle 联网后稍候自动同步。

#### 5B. 网页投送 Send to Kindle（CDP）

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

### 步骤 6：验证

- 微信读书：书架出现书名 = 成功。
- Kindle 邮件投送：用户 Kindle 上确认 = 成功（云端无法直接观测，如实说明）。
- Kindle 网页投送：`docsAll` 列表出现书名，且完成 Deliver to device。

---

## 常见故障速查

| 现象 | 处理 |
|------|------|
| `check` 无通道 | 开代理或 `ZLIB_PROXY` 指定 |
| 搜索返回「响应非 JSON」 | 换域名或网页版 CDP |
| `/dl` 下载被拒 / "Try again later" | 必须非无头真实 Chrome（`zlib-browser-dl.mjs` 已处理） |
| 微信读书上传卡 49% | 切前台标签重试 |
| Send to Kindle 找不到文件输入框 | 用 `stk-drop.mjs` 注入 drop |
| Send to Kindle 显示 No devices | 内容管理页确认有 Kindle 后重注入 |
| Kindle 投递后设备无书 | 未 Deliver to device 或漏勾设备复选框 |
| 邮件投送被拒收 | 发件邮箱未加入「已批准发件人列表」 |
| SendMessage 报 schema 错 | `to` 必须是 `[{email}]` 数组，附件用 `file_refs` |
| 邮件正文空报错 | 正文不能为空，加占位文字 |

## 安全与交互规则

- `remix_userid/remix_userkey` 只从 config.json 运行时读取，**禁止**写入文件/日志/对话。
- 不替用户输任何密码/验证码/passkey；登录墙一律引导用户自己完成。
- 每次上传前重核对文件名；交互后刷新页面状态，不复用过期元素。
- 任务结束关闭自己创建的后台 tab，保留用户原有 tab。
- 批量 ≤5 本/批，控制反爬节奏。
