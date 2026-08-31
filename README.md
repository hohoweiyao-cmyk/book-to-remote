# zlibrary-to-weread-kindle-wechatreader

WorkBuddy Skill：从 Z-Library 下载电子书，并导入微信读书（WeRead）和 Kindle 阅读器。

一条命令打通完整链路：**Z-Library 搜书下载 → 文件验证 → 微信读书导入 → Kindle 导入（网页投送 / 邮件投送二选一）**。

## 能力

- Z-Library 搜书 + 过 JS 盾下载（Playwright + 真实 Chrome）
- 自动选书（标题精确匹配 + 作者唯一 + 降权套装/合集，避免误下合集）
- 文件格式验证（EPUB/MOBI 等）
- 微信读书导入（复用浏览器登录态）
- Kindle 导入：网页投送（base64 注入 drop）或邮件投送（Agent Mail）

## 目录结构

```
.
├── SKILL.md                        # skill 定义与完整使用说明
└── scripts/
    ├── zlib-browser-dl.mjs         # Playwright 过盾下载（核心，一条命令）
    ├── zlib-download.mjs           # Z-Library API 封装（check/search/detail）
    ├── stk-drop.mjs                # Kindle 网页投送：base64 注入 + drop
    ├── verify-ebook.mjs            # 电子书文件格式验证
    ├── zl-cdp-download.mjs         # CDP 方式下载（备用）
    └── chrome-download.mjs         # Chrome 下载（备用）
```

## 安装（供其他 Agent 使用）

```bash
# 克隆到本机 skills 目录（用户级）
git clone https://github.com/hohoweiyao-cmyk/zlibrary-to-weread-kindle-wechatreader.git \
  ~/.workbuddy/skills/zlibrary-to-weread-kindle-wechatreader
```

或直接下载 zip 导入 WorkBuddy 技能市场。

## 使用前依赖（缺一不可）

| # | 依赖 | 说明 |
|---|------|------|
| 1 | Z-Library.app 已登录 | 凭据文件 `~/Library/Application Support/z-library/config.json` |
| 2 | 代理工具已开 | z-library 被墙，需 Clash/V2Ray 等 |
| 3 | Playwright + Chromium | 过 JS 盾，`npm i playwright && npx playwright install chromium` |
| 4 | web-access skill | 复用用户 Chrome 登录态（微信读书/亚马逊） |

## 使用

```bash
# 下载（一条命令）
node scripts/zlib-browser-dl.mjs "影响力 罗伯特·西奥迪尼" "~/Downloads/影响力.epub" epub
```

其余步骤（微信读书导入、Kindle 投送）见 `SKILL.md` 完整说明。

## 隐私说明

本 skill 运行时就近读取使用者本机凭据，**不硬编码任何私有账号信息**。使用者的 Kindle 邮箱、发件邮箱、设备名等均需自行填写。
