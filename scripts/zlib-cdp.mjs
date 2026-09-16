#!/usr/bin/env node
/**
 * zlib-cdp.mjs — Z-Library 搜书/下载（浏览器内闭环版）
 *
 * 与旧版 zlib-download.mjs / zlib-browser-dl.mjs 的区别（2026-09-16 重构）：
 *   1. 不需要 Z-Library.app —— 搜书走「页面内 fetch /eapi」，与浏览器同一会话；
 *   2. 不新开浏览器窗口、不抢焦点 —— 全程复用用户已开调试端口的 Chrome 的后台标签页；
 *   3. 只走官方权威域名（z-lib.sk 系）—— 不再使用被 Cloudflare 标记为钓鱼的 z-library.ec。
 *
 * 依赖：web-access 的 CDP 代理（localhost:3456）。
 *   node "<web-access>/scripts/check-deps.mjs"
 *
 * 用法：
 *   node zlib-cdp.mjs check
 *   node zlib-cdp.mjs setup [--kindle-email a@kindle.com] [--sender me@agent.qq.com] [--device NAME]
 *   node zlib-cdp.mjs login
 *   node zlib-cdp.mjs import-app
 *   node zlib-cdp.mjs search "<书名 作者>" [--format epub] [--count 20]
 *   node zlib-cdp.mjs download (--id N --hash H | --query "书名 作者") [--format epub] [--out /path/book.epub]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------------- 路径与常量 ----------------

const SKILL_DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const CONFIG_DIR = path.join(homedir(), '.workbuddy', 'zlibrary');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.local.json');
const APP_CONFIG = path.join(homedir(), 'Library/Application Support/z-library/config.json');
const PROXY = 'http://localhost:3456';

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

// ---------------- CDP 代理封装 ----------------

async function proxyOK() {
  try {
    const r = await fetch(PROXY + '/health', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return j?.connected ? j : null;
  } catch { return null; }
}

async function pnew(url) {
  const r = await fetch(PROXY + '/new', { method: 'POST', body: url });
  return (await r.json()).targetId;
}
async function peval(target, expr) {
  const r = await fetch(`${PROXY}/eval?target=${target}`, { method: 'POST', body: expr });
  const j = await r.json();
  if (j.error) throw new Error('eval 失败: ' + j.error);
  return j.value;
}
async function pnav(target, url) {
  await fetch(`${PROXY}/navigate?target=${target}`, { method: 'POST', body: url });
}
async function pclose(target) {
  try { await fetch(`${PROXY}/close?target=${target}`); } catch {}
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

/** 读取用户 Chrome 的真实下载目录（逐 profile 找 download.default_directory） */
function detectDownloadDir() {
  const cfg = loadConfig();
  if (cfg.download_dir && existsSync(cfg.download_dir)) return cfg.download_dir;
  const root = path.join(homedir(), 'Library/Application Support/Google/Chrome');
  try {
    for (const prof of readdirSync(root)) {
      const p = path.join(root, prof, 'Preferences');
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const d = j?.download?.default_directory;
        if (d && existsSync(d)) return d;
      } catch {}
    }
  } catch {}
  return path.join(homedir(), 'Downloads');
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 静默下载：导航后台标签页到 /dl，Chrome 会直接落盘。
 * 不新开窗口、不抢焦点、不弹文件对话框。
 */
async function silentDownload(target, domain, dlPath, outPath) {
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
    const fresh = now.filter((f) => !before.has(f) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
    if (fresh.length) {
      const p = path.join(dir, fresh[0]);
      try {
        if (statSync(p).size > 10240) { file = p; break; }
      } catch {}
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

  const st = statSync(file);
  if (outPath) {
    const dirOut = path.dirname(outPath);
    if (!existsSync(dirOut)) mkdirSync(dirOut, { recursive: true });
    renameSync(file, outPath);
    log(`✓ 已保存: ${outPath} (${(st.size / 1048576).toFixed(2)}MB)`);
    return { path: outPath, size: st.size };
  }
  log(`✓ 已保存: ${file} (${(st.size / 1048576).toFixed(2)}MB)`);
  return { path: file, size: st.size };
}

// ---------------- 选书打分（沿用旧版经验：避免误选套装/合集） ----------------

function score(book, anchor) {
  const t = (book.title || '').replace(/[《》]/g, '');
  const a = book.author || '';
  let sc = 0;
  if (t === anchor) sc += 100; else if (t.startsWith(anchor)) sc += 80; else if (t.includes(anchor)) sc += 50;
  if (!a.includes('&') && !a.includes('[') && a.length <= 20) sc += 30;
  if (/套装|合集|定律|导读|手册|思维|10册|全\d+册/.test(t)) sc -= 60;
  if (t.includes('精排')) sc += 5;
  return sc;
}

// ---------------- 子命令 ----------------

async function cmdCheck() {
  log('=== Z-Library 电子书链路自检 ===\n');

  // 1. CDP 代理 / Chrome
  const health = await proxyOK();
  if (!health) {
    log('✗ CDP 代理未就绪');
    log('  → 请先加载 web-access skill 并运行：node "<web-access>/scripts/check-deps.mjs"');
    process.exitCode = 1;
  } else {
    log(`✓ 浏览器 CDP: ${health.browser?.label || health.browser?.id} (端口 ${health.chromePort})，后台标签页可用`);
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
  log('  · Chrome 需关闭「下载前询问每个文件的保存位置」，否则静默下载会卡住');

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
  if (!(await proxyOK())) { warn('CDP 代理未就绪，请先运行 web-access 的 check-deps.mjs'); process.exit(1); }
  const target = await pnew('about:blank');
  const domain = (await probeAndPickDomain(target)) || 'z-lib.sk';
  log('\n我已在你的浏览器里打开 z-library 标签页（后台，不会抢焦点）：');
  log(`  https://${domain}/`);
  log('\n请切换到该标签页完成登录。登录完成后我会自动抓取凭据并保存到本机。');
  log('（登录态只用于本机后续下载，凭据存在 ~/.workbuddy/zlibrary/config.local.json）\n');

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
    for (const b of all) {
      log([
        (b.extension || '').padEnd(5),
        ((b.filesize / 1048576).toFixed(2) + 'MB').padStart(8),
        'id=' + b.id,
        'hash=' + b.hash,
        '|', b.title, '|', b.author, '|', b.year, '|', b.publisher || '-',
      ].join(' '));
    }
    if (cands.length) {
      const anchor = query.replace(/[《》]/g, '').split(/\s+/)[0];
      const best = [...cands].sort((x, y) => score(y, anchor) - score(x, anchor))[0];
      log(`\n自动选书建议: id=${best.id} hash=${best.hash} ${best.title} | ${best.author} | ${(best.filesize / 1048576).toFixed(2)}MB`);
      log('注意：体积大 ≠ 质量好。下单前建议用 download 取 2 个候选，拆包比正文与末章（见 SKILL.md 步骤 3）。');
    }
    log(`\n下载命令: node zlib-cdp.mjs download --id <id> --hash <hash> --out "<目录>/<书名>.epub"`);
  } finally { await pclose(target); }
}

async function cmdDownload(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const format = get('--format', 'epub');
  let id = get('--id'), hash = get('--hash');
  const query = get('--query'), out = get('--out');

  const { target, domain } = await openSession();
  try {
    let title = null;
    if (!id || !hash) {
      if (!query) throw new Error('需要 --id/--hash 或 --query');
      const s = await api(target, domain, `/eapi/book/search?message=${encodeURIComponent(query)}`, { count: 20, page: 1 });
      const cands = (s.books || []).filter((b) => (b.extension || '').toLowerCase() === format);
      if (!cands.length) throw new Error(`没有 ${format} 格式结果`);
      const anchor = query.replace(/[《》]/g, '').split(/\s+/)[0];
      const best = [...cands].sort((x, y) => score(y, anchor) - score(x, anchor))[0];
      id = best.id; hash = best.hash; title = best.title;
      log(`自动选定: id=${id} hash=${hash} ${best.title} | ${best.author} | ${(best.filesize / 1048576).toFixed(2)}MB`);
    }

    const d = await api(target, domain, `/eapi/book/${id}/${hash}`, null);
    const dl = d?.book?.dl;
    if (!dl) throw new Error('详情接口没有返回下载链接（可能当日额度用尽或该书不可下载）');
    if (!title) title = d?.book?.title || 'book';
    log(`dl: ${dl}`);

    const outPath = out || path.join(detectDownloadDir(), sanitize(title) + '.' + format);
    const r = await silentDownload(target, domain, dl, outPath);
    log(`\n完成。文件: ${r.path}`);
    log('下一步：node "<skill_dir>/scripts/verify-ebook.mjs" "' + r.path + '"');
  } finally { await pclose(target); }
}

// ---------------- 入口 ----------------

const [cmd, ...argv] = process.argv.slice(2);
const table = {
  check: cmdCheck, setup: cmdSetup, login: cmdLogin, 'import-app': cmdImportApp,
  search: cmdSearch, download: cmdDownload,
};

if (!cmd || !table[cmd]) {
  log(`用法: node zlib-cdp.mjs <命令>

  check                         环境自检（浏览器/凭据/本地配置/下载目录）
  setup [--kindle-email ...]    查看或写入本地私有配置（Kindle 收件/发件地址）
  login                          浏览器登录一次，抓取凭据（不需要 Z-Library.app）
  import-app                     从本机 Z-Library.app 一键导入凭据（可选）
  search "<书名 作者>"           搜书并列出候选（id/hash/大小）
  download --id N --hash H       静默下载到指定路径（或 --query 自动选书）

说明：所有凭据与 Kindle 地址只写在本机 ${CONFIG_PATH}，不会进入 skill 仓库。`);
  process.exit(cmd ? 2 : 0);
}
await table[cmd](argv);
