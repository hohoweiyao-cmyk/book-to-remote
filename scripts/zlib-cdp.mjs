#!/usr/bin/env node
/**
 * zlib-cdp.mjs — Z-Library 搜书/下载（浏览器内闭环版）
 *
 * 与旧版 zlib-download.mjs / zlib-browser-dl.mjs 的区别（2026-09-16 重构）：
 *   1. 不需要 Z-Library.app —— 搜书走「页面内 fetch /eapi」，与浏览器同一会话；
 *   2. 不新开浏览器窗口、不抢焦点 —— 全程复用用户已开调试端口的 Chrome 的后台标签页；
 *   3. 只走官方权威域名（z-lib.sk 系）—— 不再使用被 Cloudflare 标记为钓鱼的 z-library.ec。
 *
 * 依赖：同目录的 cdp.mjs（自包含专用 Chrome 实例）。
 *   不需要 web-access 的 CDP 代理，不需要任何系统授权，不需要手动点授权弹窗。
 *   首次使用跑一次：node cdp.mjs bootstrap
 *
 * 用法：
 *   node zlib-cdp.mjs check
 *   node zlib-cdp.mjs setup [--kindle-email a@kindle.com] [--sender me@agent.qq.com] [--device NAME]
 *   node zlib-cdp.mjs login
 *   node zlib-cdp.mjs import-app
 *   node zlib-cdp.mjs search "<书名 作者>" [--format epub] [--count 20]
 *   node zlib-cdp.mjs download (--id N --hash H | --query "书名 作者") [--format epub] [--out /path/book.epub]
 *                             [--force] [--overwrite]
 *   node zlib-cdp.mjs library
 *
 * 下载落盘的三道关（2026-09-19 借鉴 telegram-book-download 后加）：
 *   1. **内容关卡** —— 按文件头判定真实格式（反爬错误页会被识破），
 *      并与服务端声明的 filesize 交叉比对；只用「体积 > 10KB」判成功是不行的。
 *   2. **原子发布** —— 硬链接落盘，目标已存在即报错，绝不静默覆盖，
 *      也不会在最终路径上留下半个文件。
 *   3. **溯源留痕** —— 写 `<书>.source.json` 伴随文件 + `~/.workbuddy/zlibrary/library.json`
 *      集中索引（含 sha256 / 来源 id / 校验级别），并据此实现**幂等**：
 *      本地已有同一本时跳过下载，不浪费 Z-Library 每日额度。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, chmodSync, linkSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { inspectContainer, sha256 } from './ebook-format.mjs';
import {
  ensureBrowser, health, newTab as pnew, evalIn as peval, navigate as pnav,
  closeTab as pclose, getDownloadDir, hideWindows,
} from './cdp.mjs';

// ---------------- 路径与常量 ----------------

const SKILL_DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const CONFIG_DIR = path.join(homedir(), '.workbuddy', 'zlibrary');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.local.json');
const LIBRARY_PATH = path.join(CONFIG_DIR, 'library.json');
const APP_CONFIG = path.join(homedir(), 'Library/Application Support/z-library/config.json');

// 官方权威域名（取自 Z-Library 官方客户端下发的 domains 顺序）。
// 刻意排除 z-library.ec：该域被 Cloudflare 标记为 "Suspected Phishing"，不作为候选。
const DOMAINS = ['z-lib.sk', 'z-lib.fm', 'z-library.sk', 'z-lib.gd', 'z-lib.gl', 'z-lib.do', 'z-lib.bz', 'z-lib.fo'];

const log = (m) => process.stdout.write(m + '\n');
const warn = (m) => process.stderr.write('[warn] ' + m + '\n');

// ---------------- 本地私有配置（绝不放进 skill 目录，避免随仓库外泄） ----------------

const DEFAULT_CONFIG = {
  _comment: 'Z-Library 电子书 skill 的本地私有配置。此文件位于 skill 仓库之外，请勿提交到任何仓库。',
  kindle_email: '',
  agent_mail_sender: '',
  kindle_device: '',
  download_dir: '',
  domain: '',
  credentials: { remix_userid: '', remix_userkey: '', source: '' },
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG, credentials: { ...DEFAULT_CONFIG.credentials } };
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...c, credentials: { ...DEFAULT_CONFIG.credentials, ...(c.credentials || {}) } };
  } catch (e) {
    warn('本地配置损坏，将忽略：' + e.message);
    return { ...DEFAULT_CONFIG, credentials: { ...DEFAULT_CONFIG.credentials } };
  }
}

function saveConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
}

const mask = (v) => (v ? String(v).slice(0, 4) + '****' + String(v).slice(-4) : '(未设置)');

// ---------------- 实例守卫 ----------------

/**
 * 确保专用 Chrome 实例就绪。
 * 没跑就同步登录态 + 拉起 + 把可能出现的窗口挪到屏幕外 —— 全程无人工介入。
 */
async function ensureReady() {
  await ensureBrowser({ quiet: true });
  await hideWindows();
}

function js(v) { return JSON.stringify(v); }

// ---------------- 域名探测 / 标签页准备 ----------------

async function probeAndPickDomain(target) {
  const cfg = loadConfig();
  const order = cfg.domain ? [cfg.domain, ...DOMAINS.filter((d) => d !== cfg.domain)] : DOMAINS;
  for (const d of order) {
    try {
      await pnav(target, `https://${d}/`);
      await new Promise((r) => setTimeout(r, 3500));
      const info = JSON.parse(await peval(target, `JSON.stringify({
        title: document.title,
        text: (document.body.innerText || '').slice(0, 3000)
      })`));
      const t = info.title || '';
      const body = info.text || '';
      const bad = /DiamWall|验证您的浏览器|Suspected Phishing|Just a moment|Attention Required/i.test(t + body);
      const good = /Z-Library/i.test(t) && /Log ?In|My Library|Sign ?in|登录/i.test(body);
      if (good && !bad) { log(`✓ 可用域名: ${d}`); return d; }
      warn(`跳过 ${d}（${bad ? '被拦截/风控页' : '非预期内容'}）：${t.slice(0, 50)}`);
    } catch (e) {
      warn(`跳过 ${d}（${e.message.slice(0, 60)}）`);
    }
  }
  return null;
}

/** 建立/复用一个已过 DiamWall 且已注入凭据的标签页 */
async function openSession() {
  const cfg = loadConfig();
  await ensureReady();
  const target = await pnew('about:blank');
  const domain = await probeAndPickDomain(target);
  if (!domain) { await pclose(target); throw new Error('没有可用域名：请确认浏览器能访问 z-library（可能需要代理）'); }
  if (cfg.domain !== domain) { cfg.domain = domain; saveConfig(cfg); }

  // 注入凭据（cookie 非 HttpOnly，document.cookie 可写）
  const { remix_userid: uid, remix_userkey: key } = cfg.credentials;
  if (!uid || !key) { await pclose(target); throw new Error('缺少凭据：请先执行 `login`（浏览器登录一次）或 `import-app`（本机已装 Z-Library.app 时）'); }
  await peval(target, `(() => {
    document.cookie = 'remix_userid=${uid}; path=/; domain=.${domain}; secure; SameSite=Lax';
    document.cookie = 'remix_userkey=${key}; path=/; domain=.${domain}; secure; SameSite=Lax';
    return 'ok';
  })()`);
  return { target, domain };
}

/** 页面内调用 eapi（与页面同源同会话，因此不被 DiamWall 拦） */
async function api(target, domain, p, body) {
  const expr = `(async () => {
    try {
      const r = await fetch(${js('https://' + domain + p)}, {
        method: ${body ? "'POST'" : "'GET'"},
        headers: { 'Accept': 'application/json'${body ? ", 'Content-Type': 'application/json'" : ''} },
        ${body ? `body: ${js(JSON.stringify(body))},` : ''}
      });
      const t = await r.text();
      return JSON.stringify({ status: r.status, body: t.slice(0, 4000000) });
    } catch (e) { return JSON.stringify({ status: -1, body: String(e) }); }
  })()`;
  const raw = await peval(target, expr);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('eapi 响应无法解析：' + String(raw).slice(0, 200)); }
  let data;
  try { data = JSON.parse(parsed.body); } catch { throw new Error(`eapi 返回非 JSON（HTTP ${parsed.status}）：` + String(parsed.body).slice(0, 200)); }
  if (parsed.status >= 400) throw new Error(`eapi HTTP ${parsed.status}：` + JSON.stringify(data).slice(0, 200));
  return data;
}

// ---------------- 下载 ----------------

/**
 * 静默下载的落盘目录。
 * 由 cdp.mjs 统一决定（配置 > 日常 Chrome 的下载目录 > ~/Downloads），
 * 实例那边同时用 Browser.setDownloadBehavior 强制指向同一处 ——
 * 因此不会出现「脚本盯着 A 目录、Chrome 却存到 B 目录」的静默超时。
 */
function detectDownloadDir() { return getDownloadDir(); }

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ---------------- 本地书库索引（幂等用，保护每日下载额度） ----------------

const DEFAULT_LIBRARY = {
  _comment: '已下载书目的索引，由 download 自动维护；用于避免重复下载消耗 Z-Library 每日额度。位于 skill 仓库之外。',
  items: [],
};

function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) return { ...DEFAULT_LIBRARY, items: [] };
  try {
    const l = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'));
    return { ...DEFAULT_LIBRARY, ...l, items: Array.isArray(l.items) ? l.items : [] };
  } catch (e) {
    warn('书库索引损坏，将忽略：' + e.message);
    return { ...DEFAULT_LIBRARY, items: [] };
  }
}

function saveLibrary(lib) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LIBRARY_PATH, JSON.stringify(lib, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(LIBRARY_PATH, 0o600); } catch {}
}

const normKey = (s) => String(s || '').replace(/[\s《》（）()【】\[\]，,.、·:：]/g, '').toLowerCase();

/**
 * 在书库中查找同一本书。
 * ① 先按 book_id + hash 精确命中（最可靠）；
 * ② 再按「书名包含关系」兜底 —— 用户只会说书名，不会报 id。
 *    兜底命中只用于「跳过重复下载」，且会打印命中的记录供核对，可用 --force 推翻。
 */
function findInLibrary(lib, { id, hash, title, author }) {
  if (id && hash) {
    const hit = lib.items.find((it) => String(it.book_id) === String(id) && it.hash === hash);
    if (hit) return hit;
  }
  const q = normKey(title);
  if (q.length >= 2) {
    for (const it of lib.items) {
      const t = normKey(it.title);
      if (t.length < 2) continue;
      const nameHit = t === q || (t.length >= 4 && q.includes(t));
      if (!nameHit) continue;
      if (author && it.author && normKey(it.author) !== normKey(author)) continue;
      return it;
    }
  }
  return null;
}

// ---------------- 落盘关卡：内容校验 + 原子发布 ----------------

/**
 * 下载完成的**内容关卡**。
 * 只用「体积大于 10KB」判定成功是不行的 —— 反爬错误页轻易超过 10KB（实测 23KB），
 * 会被一路放行到投送环节。这里按真实内容判定，并按诊断给出可操作的提示。
 */
function gateDownloadedFile(file, { expectSize = null } = {}) {
  const insp = inspectContainer(file);
  if (!insp.ok) {
    const isHtml = insp.raw === 'html';
    throw new Error(
      `下载到的文件未通过校验：${insp.issues.join('；')}\n`
      + (isHtml
        ? '  · 这是反爬/限流页，不是书。**不要重试同一个链接**：先换域名或稍后再试。'
        : '  · 文件可能损坏或不完整，建议换一个版本或稍后重试。')
    );
  }
  if (expectSize != null && expectSize > 0) {
    const delta = insp.size - expectSize;
    const ratio = Math.abs(delta) / expectSize;
    if (ratio > 0.01) {
      throw new Error(
        `实际大小 ${insp.size}B 与服务端声明 ${expectSize}B 不符（相差 ${delta > 0 ? '+' : ''}${delta}B，`
        + `${(ratio * 100).toFixed(2)}%）—— 疑似截断下载或错误页，拒绝入库。`
      );
    }
  }
  return { family: insp.family, raw: insp.raw, validation: insp.validation, size: insp.size };
}

/**
 * 原子发布：把已下载的文件落到目标路径。
 * 用**硬链接**发布 —— 目标已存在时 link 直接 EEXIST，天然防覆盖；
 * 也不会出现「半个文件落在最终路径上」的中间态。
 */
function publishAtomic(src, dest, { overwrite = false } = {}) {
  const dir = path.dirname(dest);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(dest)) {
    if (!overwrite) {
      throw new Error(`目标已存在，未覆盖：${dest}\n  要覆盖请加 --overwrite；要另存请改 --out。`);
    }
    rmSync(dest, { force: true });
  }
  try {
    linkSync(src, dest);                        // 同卷：原子独占发布
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;            // 跨卷：复制到目标目录的临时名，再硬链接发布
    const tmp = path.join(dir, `.${path.basename(dest)}.part-${process.pid}`);
    try {
      copyFileSync(src, tmp);
      linkSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  rmSync(src, { force: true });
}

/** 写溯源：伴随文件（<书>.source.json）+ 集中索引，都不放进仓库 */
function recordSource(outPath, entry) {
  const sidecar = outPath + '.source.json';
  try {
    writeFileSync(sidecar, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
    chmodSync(sidecar, 0o600);
  } catch (e) {
    warn('溯源伴随文件写入失败：' + e.message);
  }
  const lib = loadLibrary();
  lib.items = lib.items.filter((it) => !(String(it.book_id) === String(entry.book_id) && it.hash === entry.hash));
  lib.items.push(entry);
  saveLibrary(lib);
  return sidecar;
}

/**
 * 静默下载：导航后台标签页到 /dl，Chrome 会自己落盘。
 * 不新开窗口、不抢焦点、不弹文件对话框。
 *
 * 与旧版的区别：落盘后先过**内容关卡**（真格式 + 与服务端声明大小比对），
 * 再用硬链接**原子发布**到 outPath —— 绝不覆盖已有文件。
 */
async function silentDownload(target, domain, dlPath, outPath, { expectSize = null, overwrite = false } = {}) {
  const dir = detectDownloadDir();
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  log(`下载目录: ${dir}`);

  await pnav(target, `https://${domain}${dlPath}`);

  const t0 = Date.now();
  let file = null;
  let round = 0;
  while (Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 1500));
    round++;
    const now = existsSync(dir) ? readdirSync(dir) : [];
    // 排除 .crdownload：Chrome 下载中用它做临时名，改回正常名即代表写完了
    const fresh = now.filter((f) => !before.has(f) && !/\.(crdownload|tmp|part)$/.test(f));
    if (fresh.length) {
      const p = path.join(dir, fresh[0]);
      // 再确认一次大小已稳定，避免拿到刚落盘、尚未写完的文件
      let s1 = -1;
      try { s1 = statSync(p).size; } catch {}
      if (s1 > 0) {
        await new Promise((r) => setTimeout(r, 700));
        let s2 = -1;
        try { s2 = existsSync(p) ? statSync(p).size : -1; } catch {}
        if (s1 === s2) { file = p; break; }
      }
    }
    // 每 8 轮（约 12s）看一眼页面，若停在错误页则提前失败
    if (round % 8 === 0 && !file) {
      try {
        const txt = await peval(target, 'document.body ? document.body.innerText.slice(0,200) : ""');
        if (/Try again later|book not found|404 Not Found/i.test(String(txt))) {
          throw new Error('下载页返回错误：' + String(txt).slice(0, 120));
        }
      } catch (e) {
        if (/下载页返回错误/.test(e.message)) throw e;
      }
    }
  }

  if (!file) {
    throw new Error(
      '等待下载超时（90s）。可能原因：\n' +
      '  · Chrome 开启了「下载前询问每个文件的保存位置」→ 请在 chrome://settings/downloads 关闭；\n' +
      '  · 浏览器未联网/需要代理；\n' +
      '  · 该版本当日下载额度已用完。'
    );
  }

  // 关卡 1：内容真的是书吗（尺寸是否为声明值）
  const gate = gateDownloadedFile(file, { expectSize });

  // 关卡 2：算哈希留痕，再原子发布
  const digest = sha256(file);
  const result = { size: gate.size, family: gate.family, raw: gate.raw, validation: gate.validation, sha256: digest };

  if (!outPath) {
    log(`✓ 已保存: ${file} (${(gate.size / 1048576).toFixed(2)}MB, 校验=${gate.validation})`);
    return { path: file, ...result };
  }
  publishAtomic(file, outPath, { overwrite });
  log(`✓ 已保存: ${outPath} (${(gate.size / 1048576).toFixed(2)}MB, 校验=${gate.validation})`);
  return { path: outPath, ...result };
}

// ---------------- 选书打分（沿用旧版经验：避免误选套装/合集） ----------------

/**
 * 选书打分。**刻意不给「精排」加分** —— SKILL.md 步骤 3 明确说
 * 「带广告的民间精排本」不要投送，打分函数不能把 agent 往反方向推。
 * 「精排」只作为**风险提示**输出（见 cautionOf），由 agent 拆包核实。
 */
function score(book, anchor) {
  const t = (book.title || '').replace(/[《》]/g, '');
  const a = book.author || '';
  let sc = 0;
  if (t === anchor) sc += 100; else if (t.startsWith(anchor)) sc += 80; else if (t.includes(anchor)) sc += 50;
  if (!a.includes('&') && !a.includes('[') && a.length <= 20) sc += 30;
  if (/套装|合集|定律|导读|手册|思维|10册|全\d+册/.test(t)) sc -= 60;
  return sc;
}

/** 命中这些词的书不否决，但必须在投送前拆包检查（SKILL.md 步骤 3） */
function cautionOf(book) {
  const t = book.title || '';
  return /精排|民间|自制|扫描/.test(t)
    ? '标题含「精排/民间/自制/扫描」——可能是带公众号广告的民间排版版，投送前务必拆包检查（SKILL.md 步骤 3）'
    : null;
}

// ---------------- 子命令 ----------------

async function cmdCheck() {
  log('=== Z-Library 电子书链路自检 ===\n');

  // 1. 专用 Chrome 实例（自动拉起，零弹窗零授权）
  const h = await health();
  if (!h) {
    log('✗ 专用 Chrome 实例未运行');
    log('  → 首次使用请跑：node "<skill_dir>/scripts/cdp.mjs" bootstrap');
    log('  → 之后本脚本会自动拉起，无需手动干预');
    process.exitCode = 1;
  } else {
    log(`✓ 专用 Chrome 实例在运行：${h.browser}（端口 ${h.port}）`);
    log('  · 独立 profile + --remote-debugging-port，结构性无授权弹窗，无需辅助功能权限');
  }

  // 2. 凭据
  const cfg = loadConfig();
  const { remix_userid: uid, remix_userkey: key } = cfg.credentials;
  if (uid && key) {
    log(`✓ 凭据: userid=${uid} key=${mask(key)}（来源: ${cfg.credentials.source || '未知'}）`);
    log('  · 无需安装 Z-Library.app');
  } else {
    log('✗ 凭据缺失');
    if (existsSync(APP_CONFIG)) log('  → 本机已装 Z-Library.app，可直接运行 `import-app` 一键导入');
    else log('  → 运行 `login`，在浏览器里登录一次 z-library 即可（不需要安装 APP）');
    process.exitCode = 1;
  }

  // 3. 本地私有配置
  log(`\n本地私有配置: ${CONFIG_PATH}`);
  log(`  · 文件存在: ${existsSync(CONFIG_PATH) ? '是' : '否（首次运行 setup 会创建）'}`);
  log(`  · 权限: 应为 600，目录 700（内含账号凭据，勿提交到仓库）`);

  // 4. Kindle 收件地址（只显示脱敏）
  log('\nKindle 邮件投送:');
  log(`  · 收件地址(kindle_email): ${cfg.kindle_email ? cfg.kindle_email.replace(/^(.{0,3})[^@]*/, '$1***') : '(未设置 → 运行 setup --kindle-email <你的@kindle.com>)'}`);
  log(`  · 发件地址(agent_mail_sender): ${cfg.agent_mail_sender ? cfg.agent_mail_sender.replace(/^(.{0,4})[^@]*/, '$1***') : '(未设置 → 先调 Agent Mail GetMe 取别名，再 setup --sender <它>)'}`);
  log('  · 发件地址必须出现在亚马逊「已批准的个人文档电子邮件发送列表」，否则会被拒收');

  // 5. 下载目录
  log(`\n下载目录: ${detectDownloadDir()}`);
  log('  · 已由 Browser.setDownloadBehavior 强制指定，不受「下载前询问保存位置」影响');

  log('\n=== 自检结束 ===');
}

async function cmdSetup(argv) {
  const cfg = loadConfig();
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const ke = get('--kindle-email'), se = get('--sender'), de = get('--device'), dd = get('--download-dir');

  if (!ke && !se && !de && !dd) {
    log('当前本地私有配置（脱敏）：');
    log(`  kindle_email       : ${cfg.kindle_email ? cfg.kindle_email.replace(/^(.{0,3})[^@]*/, '$1***') : '(未设置)'}`);
    log(`  agent_mail_sender  : ${cfg.agent_mail_sender ? cfg.agent_mail_sender.replace(/^(.{0,4})[^@]*/, '$1***') : '(未设置)'}`);
    log(`  kindle_device      : ${cfg.kindle_device || '(未设置)'}`);
    log(`  download_dir       : ${cfg.download_dir || '(自动探测)'}`);
    log(`\n配置文件: ${CONFIG_PATH}`);
    log('\n用法：node zlib-cdp.mjs setup --kindle-email <x@kindle.com> [--sender <me@agent.qq.com>] [--device <设备名>] [--download-dir <目录>]');
    log('说明：这些是私有账号信息，只写在本机 ~/.workbuddy/zlibrary/ 下，不会随 skill 仓库外泄。');
    return;
  }

  if (ke) cfg.kindle_email = ke.trim().toLowerCase();
  if (se) cfg.agent_mail_sender = se.trim().toLowerCase();
  if (de) cfg.kindle_device = de.trim();
  if (dd) cfg.download_dir = dd.trim();
  saveConfig(cfg);
  log('✓ 已写入本地私有配置（权限 600）');
  log(`  路径: ${CONFIG_PATH}`);
  if (cfg.kindle_email) log(`  收件: ${cfg.kindle_email}`);
  if (cfg.agent_mail_sender) log(`  发件: ${cfg.agent_mail_sender}`);
  if (cfg.agent_mail_sender) log('  提醒: 请确认该发件地址已在亚马逊「已批准的个人文档电子邮件发送列表」中');
}

async function cmdLogin() {
  await ensureReady();
  const target = await pnew('about:blank');
  const domain = (await probeAndPickDomain(target)) || 'z-lib.sk';
  log('\n我已在【专用 Chrome 实例】里打开 z-library 标签页（后台，不抢焦点）：');
  log(`  https://${domain}/`);
  log('\n注意：这是独立 profile 的窗口，不是你日常那个 Chrome。');
  log('请切到该窗口完成登录，登录完成后我会自动抓取凭据并保存到本机。');
  log('（凭据存在 ~/.workbuddy/zlibrary/config.local.json）\n');
  // 这一步刻意不调 hideWindows()：窗口得留在屏幕上让用户能看见并登录。

  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 4000));
    const c = await peval(target, `(() => {
      const m = {};
      (document.cookie || '').split(';').forEach(s => { const i = s.indexOf('='); if (i > 0) m[s.slice(0, i).trim()] = s.slice(i + 1); });
      return JSON.stringify({ uid: m.remix_userid || '', key: m.remix_userkey || '' });
    })()`);
    const { uid, key } = JSON.parse(c);
    if (uid && key) {
      const cfg = loadConfig();
      cfg.credentials = { remix_userid: uid, remix_userkey: key, source: 'browser-login' };
      cfg.domain = domain;
      saveConfig(cfg);
      log(`✓ 已捕获凭据并保存（userid=${uid}）。之后无需再登录，也不需要 Z-Library.app。`);
      await pclose(target);
      return;
    }
  }
  warn('5 分钟内未检测到登录，凭据未保存。可重新运行 login。');
  await pclose(target);
  process.exit(1);
}

async function cmdImportApp() {
  if (!existsSync(APP_CONFIG)) { warn(`未找到 Z-Library.app 的配置：${APP_CONFIG}\n未安装 APP 也不用担心，直接运行 login 在浏览器登录一次即可。`); process.exit(1); }
  const a = JSON.parse(readFileSync(APP_CONFIG, 'utf8'));
  const uid = a.remix_userid, key = a.remix_userkey;
  if (!uid || !key) { warn('APP 配置里没有登录凭据，请先在 APP 里登录，或改用 login。'); process.exit(1); }
  const cfg = loadConfig();
  cfg.credentials = { remix_userid: String(uid), remix_userkey: String(key), source: 'z-library-app' };
  saveConfig(cfg);
  log(`✓ 已从 Z-Library.app 导入凭据（userid=${uid}），保存到 ${CONFIG_PATH}`);
  log('  导入后本机即可不再依赖该 APP。');
}

async function cmdSearch(argv) {
  const query = argv[0];
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const format = get('--format', 'epub');
  const count = parseInt(get('--count', '20'), 10);
  if (!query) { warn('用法: node zlib-cdp.mjs search "<书名 作者>" [--format epub] [--count 20]'); process.exit(2); }

  const { target, domain } = await openSession();
  try {
    const s = await api(target, domain, `/eapi/book/search?message=${encodeURIComponent(query)}`, { count, page: 1 });
    if (s.success === false || !s.books?.length) throw new Error('搜索失败: ' + (s.error || '无结果'));
    const all = s.books;
    const cands = all.filter((b) => (b.extension || '').toLowerCase() === format);
    log(`\n共 ${all.length} 条结果，其中 ${format} 格式 ${cands.length} 条：\n`);
    const lib = loadLibrary();
    for (const b of all) {
      const have = findInLibrary(lib, { id: b.id, hash: b.hash, title: b.title, author: b.author });
      const local = have && existsSync(have.path) ? ' ★已在本地' : '';
      log([
        (b.extension || '').padEnd(5),
        ((b.filesize / 1048576).toFixed(2) + 'MB').padStart(8),
        'id=' + b.id,
        'hash=' + b.hash,
        '|', b.title, '|', b.author, '|', b.year, '|', b.publisher || '-',
        local,
      ].join(' '));
    }
    if (cands.length) {
      const anchor = query.replace(/[《》]/g, '').split(/\s+/)[0];
      const best = [...cands].sort((x, y) => score(y, anchor) - score(x, anchor))[0];
      log(`\n自动选书建议: id=${best.id} hash=${best.hash} ${best.title} | ${best.author} | ${(best.filesize / 1048576).toFixed(2)}MB`);
      const c = cautionOf(best);
      if (c) log(`⚠ 风险提示: ${c}`);
      log('注意：体积大 ≠ 质量好。下单前建议用 download 取 2 个候选，拆包比正文与末章（见 SKILL.md 步骤 3）。');
    }
    log(`\n下载命令: node zlib-cdp.mjs download --id <id> --hash <hash> --out "<目录>/<书名>.epub"`);
  } finally { await pclose(target); }
}

async function cmdDownload(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const has = (k) => argv.includes(k);
  const format = get('--format', 'epub');
  let id = get('--id'), hash = get('--hash');
  const query = get('--query'), out = get('--out');
  const force = has('--force');          // 忽略本地已有，强制重新下载
  const overwrite = has('--overwrite');  // 允许覆盖同名目标文件

  // 0) 幂等检查：本地已有同一本书且文件还在 → 直接复用，**不消耗每日下载额度**
  if (!force) {
    const hit = findInLibrary(loadLibrary(), { id, hash, title: query });
    if (hit && existsSync(hit.path)) {
      log(`✓ 本地已有，跳过下载（不消耗 Z-Library 每日额度）`);
      log(`  文件: ${hit.path}`);
      log(`  来源: id=${hit.book_id} hash=${hit.hash} 校验=${hit.validation}`);
      log(`  下载于: ${hit.downloaded_at}  sha256=${String(hit.sha256 || '').slice(0, 16)}…`);
      log('  如需强制重新下载，加 --force。');
      return;
    }
    if (hit) warn(`索引里有记录但文件已不在本地（${hit.path}），将重新下载。`);
  }

  // 0.5) 目标已存在且未允许覆盖 → **提前失败**，别等下载完才发现，白耗一次额度
  if (out && existsSync(out) && !overwrite) {
    throw new Error(`目标已存在，未覆盖：${out}\n  要覆盖请加 --overwrite；要另存请改 --out。`);
  }

  const { target, domain } = await openSession();
  try {
    const meta = { title: null, author: null, year: null, publisher: null };
    let declaredSize = null;

    if (!id || !hash) {
      if (!query) throw new Error('需要 --id/--hash 或 --query');
      const s = await api(target, domain, `/eapi/book/search?message=${encodeURIComponent(query)}`, { count: 20, page: 1 });
      const cands = (s.books || []).filter((b) => (b.extension || '').toLowerCase() === format);
      if (!cands.length) throw new Error(`没有 ${format} 格式结果`);
      const anchor = query.replace(/[《》]/g, '').split(/\s+/)[0];
      const best = [...cands].sort((x, y) => score(y, anchor) - score(x, anchor))[0];
      id = best.id; hash = best.hash;
      Object.assign(meta, { title: best.title, author: best.author, year: best.year, publisher: best.publisher });
      declaredSize = Number(best.filesize) || null;
      log(`自动选定: id=${id} hash=${hash} ${best.title} | ${best.author} | ${(best.filesize / 1048576).toFixed(2)}MB`);
      const c = cautionOf(best);
      if (c) log(`⚠ 风险提示: ${c}`);
    }

    const d = await api(target, domain, `/eapi/book/${id}/${hash}`, null);
    const dl = d?.book?.dl;
    if (!dl) throw new Error('详情接口没有返回下载链接（可能当日额度用尽或该书不可下载）');
    meta.title = meta.title || d?.book?.title || null;
    meta.author = meta.author || d?.book?.author || null;
    meta.year = meta.year ?? d?.book?.year ?? null;
    meta.publisher = meta.publisher || d?.book?.publisher || null;
    declaredSize = declaredSize ?? (Number(d?.book?.filesize) || null);
    // 下载链接属于会话内凭据，不打印全文
    log(`✓ 已取得下载链接（${domain}，链接不回显）`);

    const outPath = out || path.join(detectDownloadDir(), sanitize(meta.title || 'book') + '.' + format);
    const r = await silentDownload(target, domain, dl, outPath, { expectSize: declaredSize, overwrite });

    // 溯源留痕：伴随文件 + 集中索引
    const entry = {
      status: 'downloaded',
      path: r.path,
      book_id: id,
      hash,
      title: meta.title,
      author: meta.author,
      year: meta.year,
      publisher: meta.publisher,
      extension: format,
      domain,
      declared_filesize: declaredSize,
      size: r.size,
      format: r.family,
      validation: r.validation,
      sha256: r.sha256,
      downloaded_at: new Date().toISOString(),
      delivered: {},
    };
    const sidecar = recordSource(r.path, entry);

    log(`\n完成。文件: ${r.path}`);
    log(`  体积 ${(r.size / 1048576).toFixed(2)}MB · 校验 ${r.validation}`
      + (declaredSize ? ` · 与服务端声明一致（${declaredSize}B）` : ' · 未取到服务端声明大小，仅做容器校验'));
    log(`  溯源: ${sidecar}`);
    log('下一步：node "<skill_dir>/scripts/verify-ebook.mjs" "' + r.path + '"');
  } finally { await pclose(target); }
}

// ---------------- 本地书库 ----------------

function cmdLibrary(argv) {
  const lib = loadLibrary();
  if (!lib.items.length) {
    log('本地书库为空。下载成功的书会自动记录在这里。');
    log(`索引位置: ${LIBRARY_PATH}`);
    return;
  }
  const missing = [];
  log(`本地书库（${lib.items.length} 本）—— 用于避免重复下载\n索引: ${LIBRARY_PATH}\n`);
  for (const it of lib.items) {
    const alive = existsSync(it.path);
    if (!alive) missing.push(it.path);
    log([
      (it.extension || '?').padEnd(5),
      ((it.size || 0) / 1048576).toFixed(2).padStart(7) + 'MB',
      'id=' + it.book_id,
      alive ? '✓' : '✗文件缺失',
      '|', it.title, '|', it.author || '-',
      '|', String(it.downloaded_at || '').slice(0, 10),
      '|', String(it.sha256 || '').slice(0, 12),
    ].join(' '));
    log('    ' + it.path);
  }
  if (missing.length) {
    log(`\n注意：${missing.length} 条记录的文件已不在本地（被移动或删除）。`);
    log('这些书再次下载时会重新获取（会重新消耗额度）。想重建索引，删掉对应条目即可。');
  }
}

// ---------------- 入口 ----------------

const [cmd, ...argv] = process.argv.slice(2);
const table = {
  check: cmdCheck, setup: cmdSetup, login: cmdLogin, 'import-app': cmdImportApp,
  search: cmdSearch, download: cmdDownload, library: cmdLibrary,
};

if (!cmd || !table[cmd]) {
  log(`用法: node zlib-cdp.mjs <命令>

  check                         环境自检（浏览器/凭据/本地配置/下载目录）
  setup [--kindle-email ...]    查看或写入本地私有配置（Kindle 收件/发件地址）
  login                          浏览器登录一次，抓取凭据（不需要 Z-Library.app）
  import-app                     从本机 Z-Library.app 一键导入凭据（可选）
  search "<书名 作者>"           搜书并列出候选（id/hash/大小；本地已有的标 ★）
  download --id N --hash H       静默下载到指定路径（或 --query 自动选书）
            [--out <路径>] [--force] [--overwrite]
                                 · 先过内容校验 + 与服务端声明大小比对
                                 · 原子发布，目标已存在默认报错不覆盖（--overwrite 才覆盖）
                                 · 本地已有同一本则跳过，不消耗每日额度（--force 强制重下）
  library                        列出已下载书目与溯源信息（sha256 / 来源 id / 校验级）

说明：凭据、Kindle 地址与书库索引只写在本机，不会进入 skill 仓库。
  私有配置: ${CONFIG_PATH}
  书库索引: ${LIBRARY_PATH}`);
  process.exit(cmd ? 2 : 0);
}
// 顶层错误出口：只打印可读的 message，不吐 Node 堆栈
// （堆栈里可能带上 URL 等会话信息，且对使用者毫无价值）
try {
  await table[cmd](argv);
} catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
