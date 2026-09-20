#!/usr/bin/env node
/**
 * cdp.mjs — 自包含的 CDP 层（浏览器实例守卫 + 直连客户端）
 *
 * 为什么不用 web-access 的 CDP 代理（localhost:3456）：
 *   那个代理会把浏览器发现限制在固定端口 9222/9229/9333，并且连用户日常 Chrome 时
 *   每建一条 WebSocket 都要用户点「允许远程调试」授权框，无法持久化。本模块改用
 *   Chrome 官方推荐的专用 profile 实例 —— 结构性零弹窗、零系统权限、零人工点击。
 *
 * 设计要点（都是实测踩出来的，别随意改）：
 *   1. 必须带非默认 --user-data-dir。Chrome 136+ 起 --remote-debugging-port 在默认
 *      profile 上被完全忽略，无 flag/policy 可绕（官方反 cookie 窃取设计）。
 *   2. 必须 --no-startup-window。启动时不创建任何窗口 → 用户完全无感。
 *   3. 不能无头（--headless=new）。Z-Library 的 DiamWall 会直接回 Access Denied。
 *   4. 标签页用 Target.createTarget + background:true 创建，不抢焦点。
 *   5. 下载目录用 Browser.setDownloadBehavior 强制指定，不依赖 profile 的 Preferences，
 *      顺带免疫「下载前询问保存位置」这个经典卡点。
 *
 * 用法：
 *   node cdp.mjs check                    环境自检
 *   node cdp.mjs bootstrap                首次部署：建 profile + 迁登录态 + 拉起实例
 *   node cdp.mjs ensure                   确保实例就绪（没跑就自动拉起）
 *   node cdp.mjs tabs                     列出标签页
 *   node cdp.mjs new <url>                新建后台标签页，输出 targetId
 *   node cdp.mjs eval <target> <expr>     在标签页里求值（支持 await）
 *   node cdp.mjs nav <target> <url>       导航
 *   node cdp.mjs click <target> <selector>
 *   node cdp.mjs setfiles <target> <selector> <文件路径...>
 *   node cdp.mjs close <target>           关闭标签页
 *   node cdp.mjs sync-cookies             从日常 Chrome 重新同步登录态
 *   node cdp.mjs kill                     停止专用实例（会连带收走所有标签页）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync, chmodSync, rmSync, readlinkSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const HOME = homedir();
const CONFIG_DIR = path.join(HOME, '.workbuddy', 'chrome-cdp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.local.json');
// Playwright 分发浏览器的地方（跨平台）。用户没装任何浏览器时，就靠这里的 Chromium 兜底。
const PLAYWRIGHT_CACHE = process.platform === 'darwin'
  ? path.join(HOME, 'Library', 'Caches', 'ms-playwright')
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'ms-playwright')
    : path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'ms-playwright');
// 本机受管 Node 的 workspace（zlib-browser-dl.mjs 也从这里解析 playwright）
const NODE_WORKSPACE = path.join(HOME, '.workbuddy', 'binaries', 'node', 'workspace');

const DEFAULTS = {
  _comment: '专用 Chrome 实例的本地配置。位于 skill 仓库之外，请勿提交到任何仓库。',
  port: 9444,
  // 留空 = 按浏览器身份自动推导（见 computeProfileDir）。**不要**把两种身份的浏览器指向
  // 同一个目录，否则会因为 cookie 加密密钥不同而互相清空登录态（实测见 computeProfileDir 注释）。
  profile_dir: '',
  chrome_bin: '',
  source_root: '',
  source_profile: 'Default',
  download_dir: '',
  auto_launch: true,
  // 空闲多久自动释放专用实例（秒）。见文件末尾「为什么要自动释放」的说明。
  // 设为 0 表示永不自动释放（不建议：会长期挡住用户自己的 Chrome）。
  idle_release_seconds: 600,
};

// 最近一次 CDP 活动的时间戳，供看门狗判断实例是否已空闲
const ACTIVITY_PATH = path.join(CONFIG_DIR, 'last-activity');
const WATCHDOG_PID_PATH = path.join(CONFIG_DIR, 'watchdog.pid');

// 刻意不 return：process.stdout.write 返回布尔值，透传出去会被赋给 process.exitCode 而报警
export const log = (m) => { process.stdout.write(m + '\n'); };
export const warn = (m) => { process.stderr.write('[warn] ' + m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记一次 CDP 活动。任何一条 cdp.mjs 命令最终都会 connect()，所以这是天然的「有人在用」信号。 */
function touchActivity() {
  try { writeFileSync(ACTIVITY_PATH, String(Date.now())); } catch {}
}

/** 距上次 CDP 活动过了多少秒；从未记录过则返回 Infinity（视为可以立即释放） */
function idleSeconds() {
  try { return (Date.now() - Number(readFileSync(ACTIVITY_PATH, 'utf8'))) / 1000; } catch { return Infinity; }
}

// ---------------- 配置 ----------------

/** 只读原始配置文件、不补默认值。给 resolveBrowser() 用，避免与 loadConfig() 互相递归。 */
function peekConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; }
}

export function loadConfig() {
  let raw;
  if (!existsSync(CONFIG_PATH)) raw = {};
  else {
    try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}; }
    catch (e) { warn('CDP 配置损坏，改用默认值：' + e.message); raw = {}; }
  }
  const cfg = { ...DEFAULTS, ...raw };
  // profile_dir 留空 = 按浏览器身份推导（两种身份不能共用一个目录，见 computeProfileDir）
  if (!cfg.profile_dir) cfg.profile_dir = computeProfileDir(resolveBrowser()?.kind || 'system');
  return cfg;
}

export function saveConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const { _comment, ...rest } = { ...DEFAULTS, ...cfg };
  writeFileSync(CONFIG_PATH, JSON.stringify({ _comment, ...rest }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
}

// ---------------- 浏览器与 profile 定位 ----------------

/**
 * 系统已装的 Chromium 系浏览器。**优先用它**：它能复用从用户日常 Chrome 同步来的登录态
 * （同一个 app 身份 = 同一把 Keychain cookie 密钥，文件级复制就能生效）。
 */
const CHROME_CANDIDATES = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  path.join(HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  // Linux
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  // Windows
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
];

/** Playwright 自带的 Chromium（Chrome for Testing 构建）在各平台下的相对路径 */
const BUNDLED_RELS = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome', 'chrome-linux/chrome',
  'chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
];

/** 路径是否属于 Playwright 分发的浏览器（用来判定身份） */
function isBundledBin(p) {
  return /ms-playwright|Chrome for Testing|chrome-linux|chrome-win/i.test(p || '');
}

/**
 * Playwright 随包分发的 Chromium —— **用户没装任何浏览器时的兜底**。
 *
 *   · 不依赖用户装过什么：这是「零前提」的来源，Safari / Firefox 用户也能跑
 *   · bundle id 是 com.google.chrome.for.testing，与用户的 com.google.Chrome 不同
 *     → 不会抢占用户浏览器的应用身份（实测两者可同时在线互不干扰）
 *   · 但**读不到系统 Chrome 写的 cookie**（Keychain 密钥按 app 身份隔离）→ 必须用独立 profile
 */
export function findBundledChromium() {
  // 1) 先问 Playwright 官方 API：它自己维护 revision 目录名，比手工拼路径稳
  try {
    const req = createRequire(path.join(NODE_WORKSPACE, 'package.json'));
    for (const mod of ['playwright', 'playwright-core']) {
      try {
        const p = req(mod)?.chromium?.executablePath?.();
        if (p && existsSync(p)) return p;
      } catch { /* 该模块没装，试下一个 */ }
    }
  } catch { /* workspace 不存在 */ }
  // 2) Playwright 没装或 API 不可用 → 直接扫它的缓存目录，取 revision 最大的
  let revs;
  try {
    revs = readdirSync(PLAYWRIGHT_CACHE).filter((d) => /^chromium[-_]/.test(d) && !/headless/.test(d));
  } catch { return null; }
  revs.sort((a, b) => Number((b.match(/\d+/) || [0])[0]) - Number((a.match(/\d+/) || [0])[0]));
  for (const rev of revs) {
    for (const rel of BUNDLED_RELS) {
      const p = path.join(PLAYWRIGHT_CACHE, rev, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 选一个可执行的浏览器，并给出它的「身份」。身份决定两件事：用哪个 profile、登录态能不能同步。
 *
 *   kind='system'  → 系统已装的 Chromium 系。与用户日常 Chrome 共享 cookie 密钥，
 *                    `sync-cookies` 的文件级复制有效。
 *   kind='bundled' → Playwright 自带的 Chrome for Testing。密钥独立，**同步过来也读不了**，
 *                    必须在它自己的实例里登录一次。
 */
export function resolveBrowser() {
  const raw = peekConfig();
  if (raw.chrome_bin && existsSync(raw.chrome_bin)) {
    return { bin: raw.chrome_bin, kind: isBundledBin(raw.chrome_bin) ? 'bundled' : 'system', source: 'config' };
  }
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return { bin: p, kind: 'system', source: 'system' };
  const b = findBundledChromium();
  if (b) return { bin: b, kind: 'bundled', source: 'playwright' };
  return null;
}

/** 兼容旧调用点：只要可执行路径 */
export function findChrome() {
  return resolveBrowser()?.bin || null;
}

/**
 * profile 目录按浏览器身份分开 —— **必须分开**。
 *
 * macOS 上 Chromium 系的 cookie 加密密钥存在 Keychain，条目名由 app 身份（product name）
 * 决定，不同 bundle 的浏览器拿不到彼此的密钥。共用同一个 profile 目录时，Chrome 不报错，
 * 而是**直接把 cookie 库清空重建**。实测（2026-09-20）：把 751 条 cookie（含微信读书
 * wr_vid、亚马逊 at-main）的 profile 交给 Playwright 的 Chrome for Testing 启动，
 * 无论 151 还是 153 版，启动后都变成 0 条（源 profile 不受影响）。
 * 所以两种身份一旦共用目录，就会互相摧毁登录态。
 */
function computeProfileDir(kind) {
  return kind === 'bundled'
    ? path.join(CONFIG_DIR, 'profile-bundled')
    : path.join(CONFIG_DIR, 'profile');
}

/** 用户日常 Chrome 的 user-data-dir 根目录 */
export function findSourceRoot() {
  const cfg = loadConfig();
  if (cfg.source_root && existsSync(cfg.source_root)) return cfg.source_root;
  const cands = [
    path.join(HOME, 'Library/Application Support/Google/Chrome'),
    path.join(HOME, 'Library/Application Support/Chromium'),
    path.join(HOME, 'Library/Application Support/Microsoft Edge'),
  ];
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}

/**
 * 从日常 Chrome 迁移登录态。
 * 只在专用实例【没在跑】时执行：Chrome 退出时会回写 Cookies，边跑边覆盖会互相冲掉。
 * 迁移的是 Cookies 数据库 —— macOS 上它由 Keychain 的 "Chrome Safe Storage" 加密，
 * 该密钥按应用（而非按 profile）下发，所以同机同应用换个 profile 仍能解密。
 */
export function syncCookies({ verbose = true } = {}) {
  const cfg = loadConfig();
  // 文件级复制只在同一 app 身份内有效（cookie 密钥存在 Keychain，条目名由 app 身份决定）。
  // Playwright 自带的 Chromium 与日常 Chrome 的密钥不同，复制过去也解不开，白费一次拷贝。
  const browser = resolveBrowser();
  if (browser?.kind === 'bundled') {
    const hasCookies = existsSync(path.join(cfg.profile_dir, 'Default', 'Cookies'));
    if (!hasCookies && verbose) {
      warn('当前使用 Playwright 自带的 Chromium —— 它与日常 Chrome 的 cookie 密钥不同，无法同步登录态。');
      warn('  这是预期行为（同一 profile 目录跨 app 使用会互相清空 cookie，实测过）。');
      warn('  首次使用请在这个专用实例里登录一次，之后长期有效：');
      warn('    · Z-Library：不需要登录（走 API 凭据）');
      warn('    · 微信读书 / 亚马逊(Send to Kindle)：需要在专用实例的窗口里各登录一次');
    }
    return false;
  }
  const root = findSourceRoot();
  if (!root) { warn('找不到日常 Chrome 的数据目录，跳过登录态同步'); return false; }

  // 选源 profile：显式配置优先；否则取 Default，没有就取 Cookie 库最大的那个
  let srcName = cfg.source_profile;
  if (!existsSync(path.join(root, srcName, 'Cookies'))) {
    const cands = readdirSync(root).filter((d) => existsSync(path.join(root, d, 'Cookies')));
    if (!cands.length) { warn(`源 profile 里没有 Cookies 数据库：${root}`); return false; }
    srcName = cands
      .map((d) => ({ d, size: statSync(path.join(root, d, 'Cookies')).size }))
      .sort((a, b) => b.size - a.size)[0].d;
  }
  const srcDir = path.join(root, srcName);
  const dstDir = path.join(cfg.profile_dir, 'Default');
  mkdirSync(path.join(dstDir, 'Network'), { recursive: true });

  let n = 0;
  for (const f of ['Cookies', 'Cookies-journal', 'Local State']) {
    const s = path.join(srcDir, f);
    if (!existsSync(s)) continue;
    copyFileSync(s, path.join(dstDir, f));
    n++;
  }
  // Local Storage 只在首次部署时整体搬一次（可能上百 MB，不适合每次都同步）
  const srcLS = path.join(srcDir, 'Local Storage');
  const dstLS = path.join(dstDir, 'Local Storage');
  if (existsSync(srcLS) && !existsSync(dstLS)) {
    mkdirSync(path.dirname(dstLS), { recursive: true });
    cpR(srcLS, dstLS);
    n++;
  }
  if (verbose && n) log(`✓ 已从日常 Chrome 的「${srcName}」迁移 ${n} 项登录态`);
  else if (verbose) warn('源目录里没有可迁移的登录态文件');
  return n > 0;
}

function cpR(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpR(s, d);
    else if (e.isFile()) { try { copyFileSync(s, d); } catch {} }
  }
}

/** 静默下载的落盘目录：配置 > 日常 Chrome 的下载目录 > ~/Downloads */
export function getDownloadDir() {
  const cfg = loadConfig();
  if (cfg.download_dir && existsSync(cfg.download_dir)) return cfg.download_dir;
  const root = findSourceRoot();
  if (root) {
    for (const prof of ['Default', ...readdirSync(root).filter((d) => /^Profile /.test(d))]) {
      const p = path.join(root, prof, 'Preferences');
      if (!existsSync(p)) continue;
      try {
        const d = JSON.parse(readFileSync(p, 'utf8'))?.download?.default_directory;
        if (d && existsSync(d)) return d;
      } catch {}
    }
  }
  return path.join(HOME, 'Downloads');
}

// ---------------- 实例守卫 ----------------

/** 实例是否活着（node fetch 不读 HTTP_PROXY，所以不受环境代理劫持影响） */
export async function health() {
  const cfg = loadConfig();
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/json/version`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.webSocketDebuggerUrl) return null;
    return { connected: true, port: cfg.port, browser: j.Browser, wsUrl: j.webSocketDebuggerUrl };
  } catch { return null; }
}

export async function isUp() { return !!(await health()); }

function launch() {
  const cfg = loadConfig();
  const b = resolveBrowser();
  if (!b) {
    throw new Error(
      '找不到任何可用的浏览器。两种解决方式任选其一：\n' +
      `  · 装一个 Chrome / Chromium / Edge；或在配置里显式指定 chrome_bin（${CONFIG_PATH}）\n` +
      '  · 用 Playwright 自带的 Chromium（不依赖用户装浏览器，Safari/Firefox 用户也能跑）：\n' +
      `    cd ${NODE_WORKSPACE} && npm i playwright && npx playwright install chromium`
    );
  }
  const bin = b.bin;
  // 端口已有人听 = 实例其实活着（可能只是 CDP 一时忙）。此时再 spawn 一个同 profile 的
  // Chrome 会撞单例锁，启动即 CHECK 崩溃 → macOS 弹「意外退出」。宁可不拉，也不能撞。
  if (liveSingletonPid()) {
    throw new Error(`profile 单例锁仍被 pid ${liveSingletonPid()} 占用，拒绝重复拉起。若确认该进程已死，先 \`node cdp.mjs kill\``);
  }
  if (!existsSync(cfg.profile_dir)) mkdirSync(cfg.profile_dir, { recursive: true });
  const args = [
    `--user-data-dir=${cfg.profile_dir}`,
    `--remote-debugging-port=${cfg.port}`,
    '--no-startup-window',       // 启动不建窗口：用户完全无感
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--restore-last-session=false',
    // 关掉后台标签节流：微信读书传书页在后台标签会被限速卡在 ~49%，
    // 关掉节流后后台标签也能全速跑完，不需要把标签切前台。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    // 关掉端侧模型下载：实测 OptGuideOnDeviceModel 单个目录能吃到 4.0G
    '--disable-features=OptimizationGuideOnDeviceModel,OptimizationGuideModelDownloading,Translate,MediaRouter,GlobalMediaControls',
    // 不建 GPU 进程。专用实例是「无窗口 + 后台标签」纯自动化用途，用不到 GPU；而从受管环境
    // 启动时 Chrome 辅助进程的沙箱初始化会失败（instance.log 里刷 "sandbox initialization
    // failed: Operation not permitted" → GPU 进程 exit_code=6 反复重启 → 最后
    // FATAL "GPU process isn't usable. Goodbye." 直接收走浏览器，macOS 就弹「意外退出」）。
    // 去掉 GPU 进程等于掐掉这条崩溃链，渲染走软件路径，对 z-library / 微信读书 / 亚马逊无影响。
    '--disable-gpu',
  ];
  // 把 Chrome 自己的 stdout/stderr 落盘。启动期 CHECK 崩溃在系统崩溃报告里是无符号的
  // （只有一个 ChromeMain 栈），唯一能拿到原因的地方就是这里。stdio:'ignore' 等于把线索丢掉。
  let stdio = 'ignore';
  try {
    const fd = openSync(path.join(CONFIG_DIR, 'instance.log'), 'a');
    stdio = ['ignore', fd, fd];
  } catch {}
  const p = spawn(bin, args, { detached: true, stdio });
  p.unref();
  startWatchdog();
}

/**
 * 为什么要自动释放（2026-09-20 实测确认的一个严重副作用）：
 *
 * 专用实例和用户日常 Chrome 是同一个 app bundle（com.google.Chrome），所以它在
 * LaunchServices 里注册成"Chrome 的前台应用实例"。只要它还活着，macOS 处理"点 Dock
 * 图标 / Spotlight / open -a"时就只会把请求交给它，**不会启动用户的日常 Chrome**；
 * 而它带 --no-startup-window 且窗口早被 hideWindows 挪出屏幕，实测对 reopen 事件
 * 也不建窗口 → 屏幕上什么都不出现，用户感受就是「浏览器点击没反应」。
 *
 * 实测：实例存活时 `open -a "Google Chrome"` 退出码 0 但新增进程数 0；
 * 释放该实例后立刻正常拉起日常 Chrome（11 个 renderer）。
 *
 * 结论：常驻省下的那几秒冷启动，不值得让用户失去浏览器。默认空闲 10 分钟即自动让位，
 * 且任务收尾应主动 `kill`（见 SKILL.md）。
 */
let watchdogStarted = false;     // 同一进程内只 spawn 一次（launch 可能被不同入口重复触发）

function startWatchdog() {
  if (watchdogStarted) return;
  const cfg = loadConfig();
  const ttl = Number(cfg.idle_release_seconds ?? DEFAULTS.idle_release_seconds);
  if (!(ttl > 0)) return;
  // 已有看门狗在跑就不重复 spawn
  try {
    const old = Number(readFileSync(WATCHDOG_PID_PATH, 'utf8'));
    if (old > 0) { process.kill(old, 0); return; }
  } catch {}
  watchdogStarted = true;
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watchdog', '--ttl', String(ttl)], {
    detached: true, stdio: 'ignore',
  });
  p.unref();
}

/** 释放实例后把看门狗也一并收走，免得它空转一轮（最多 30s）才自己发现 */
function reapWatchdogs() {
  try {
    const pid = Number(readFileSync(WATCHDOG_PID_PATH, 'utf8'));
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) process.kill(pid);
  } catch {}
  try { rmSync(WATCHDOG_PID_PATH, { force: true }); } catch {}
}

/** 看门狗：空闲超过 TTL 就主动释放实例，把 Chrome 的「应用身份」还回给用户 */
async function cmdWatchdog(argv) {
  const i = argv.indexOf('--ttl');
  const cfg = loadConfig();
  const ttl = i >= 0 ? Number(argv[i + 1]) : Number(cfg.idle_release_seconds ?? DEFAULTS.idle_release_seconds);
  try { writeFileSync(WATCHDOG_PID_PATH, String(process.pid)); } catch {}
  // 短 TTL（测试用）也要能及时响应，所以检查间隔随 TTL 收缩，上限 30s
  const interval = Math.max(2000, Math.min(30000, (ttl * 1000) / 4));
  try {
    for (;;) {
      await sleep(interval);
      // 实例已经不在了（用户自己退出 / 被 kill）→ 收工
      if (!(await isUp()) && !liveSingletonPid()) return 0;
      if (idleSeconds() > ttl) {
        const ttlText = ttl >= 60 ? `${Math.round(ttl / 60)} 分钟` : `${ttl} 秒`;
        log(`· 专用实例已空闲超过 ${ttlText}，自动释放（把 Chrome 的应用身份还给日常浏览器）`);
        await releaseInstance({ quiet: true });
        return 0;
      }
    }
  } finally {
    try { rmSync(WATCHDOG_PID_PATH, { force: true }); } catch {}
  }
}

/** SingletonLock 指向的 pid —— 仅当该进程确实还活着时才返回（陈旧锁不算） */
function liveSingletonPid() {
  const cfg = loadConfig();
  try {
    const t = readlinkSync(path.join(cfg.profile_dir, 'SingletonLock'));   // "host-<pid>"
    const pid = Number(t.split('-').pop());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);                                                  // 存活探测
    return pid;
  } catch { return null; }
}

/** 端口是否已有人在听。不依赖 HTTP：CDP 忙时 /json/version 会超时，但端口还在 */
function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const fin = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    setTimeout(() => fin(false), 1000);
  });
}

/** 轮询等健康检查通过 */
async function waitForHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await isUp()) return true;
    await sleep(500);
  }
  return await isUp();
}

/** profile 里只可再生的胖目录（专有 profile，删了 Chrome 会自己重建，不影响登录态） */
const PRUNABLE = ['OptGuideOnDeviceModel', 'optimization_guide_model_store', 'Default/Cache', 'Default/Code Cache', 'BrowserMetrics'];

/**
 * 清理可再生缓存。必须在实例停止时做。
 * 不删 Default/Cookies、Local Storage、Preferences —— 那些是登录态。
 */
export function pruneProfile({ verbose = true } = {}) {
  const cfg = loadConfig();
  const freed = [];
  for (const rel of PRUNABLE) {
    const p = path.join(cfg.profile_dir, rel);
    if (!existsSync(p)) continue;
    let size = 0;
    try { size = dirSize(p); } catch {}
    if (size < 50 * 1024 * 1024) continue;      // 小于 50MB 不值得动
    try {
      rmR(p);
      freed.push(`${rel} (${(size / 1073741824).toFixed(2)}GB)`);
    } catch {}
  }
  if (verbose && freed.length) log('✓ 已清理可再生缓存：' + freed.join('、'));
  return freed;
}

function dirSize(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    try { n += dirSize(path.join(p, e.name)); } catch {}
  }
  return n;
}

function rmR(p) {
  rmSync(p, { recursive: true, force: true });
}

/**
 * 确保专用实例就绪。返回 true 表示本次是新拉起的。
 * 拉起前会同步登录态（只在实例未运行时做，避免互相覆盖）。
 */
export async function ensureBrowser({ quiet = false } = {}) {
  const cfg = loadConfig();
  if (await isUp()) return false;
  if (!cfg.auto_launch) throw new Error(`专用实例未运行，且 auto_launch=false。请手动启动后重试（端口 ${cfg.port}）`);

  // 宽限重试：单次 /json/version 超时（2.5s）常只是实例一时忙（正在收标签页 / GC），
  // 不代表它没在跑。这里若直接拉起，就会撞上单例锁 → 旧实例崩溃 + 新实例也起不来。
  if (await waitForHealth(3000)) return false;

  const owner = liveSingletonPid();
  if (owner || (await portListening(cfg.port))) {
    if (!quiet) log(`· 端口 ${cfg.port} 已占用（pid ${owner ?? '未知'}），等待实例响应，不重复拉起`);
    if (await waitForHealth(25000)) { await applyDownloadBehavior(); return false; }
    throw new Error(
      `端口 ${cfg.port} 被占用（pid ${owner ?? '未知'}）但 CDP 无响应。\n` +
      `  先 \`node cdp.mjs kill\`（会等实例真正退出再返回），再重试；\n` +
      `  想直接看进程：lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN`
    );
  }

  syncCookies({ verbose: !quiet });
  pruneProfile({ verbose: !quiet });
  launch();
  if (await waitForHealth(30000)) {
    if (!quiet) log(`✓ 专用实例已就绪（端口 ${cfg.port}）`);
    await applyDownloadBehavior();
    return true;
  }
  throw new Error(
    `拉起专用实例超时（30s，端口 ${cfg.port}）。排查：\n` +
    `  · Chrome 启动日志（含 CHECK 崩溃原因）：tail -30 "${path.join(CONFIG_DIR, 'instance.log')}"\n` +
    `  · 手动执行看报错："${resolveBrowser()?.bin || '<未找到浏览器>'}" --user-data-dir="${cfg.profile_dir}" --remote-debugging-port=${cfg.port}\n` +
    `  · 端口被占：lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN`
  );
}

/** 强制下载落盘目录，绕开 profile Preferences 与「下载前询问保存位置」 */
export async function applyDownloadBehavior(dir) {
  const target = dir || getDownloadDir();
  const cdp = await connect();
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: target });
    return target;
  } finally { cdp.close(); }
}

/** 兜底：把可能出现的窗口挪到屏幕外（窗口最小化 CDP 无效，只能挪） */
export async function hideWindows({ except } = {}) {
  const cdp = await connect();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      if (except && t.targetId === except) continue;
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId });
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -10000, top: 0 } });
      } catch {}
    }
  } finally { cdp.close(); }
}

/**
 * 把窗口挪回屏幕内并置于最前。只在需要用户亲自操作（登录 / 过验证码）时调用。
 * 与 hideWindows 是一对：自动化路径用 hideWindows，人工介入路径用 showWindow。
 */
export async function showWindow(targetId) {
  const cdp = await connect();
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 60, width: 1100, height: 800, windowState: 'normal' } });
    await cdp.send('Page.bringToFront', {}, (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId);
    return windowId;
  } finally { cdp.close(); }
}

// ---------------- CDP 客户端 ----------------

/** 建立到浏览器的 WebSocket，返回 { send, close } */
export async function connect() {
  const h = await health();
  if (!h) throw new Error('专用实例未就绪，请先调用 ensureBrowser() 或运行 `node cdp.mjs ensure`');
  touchActivity();                 // 有人连上来 = 有人在用，重置空闲计时
  const ws = new WebSocket(h.wsUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? rej(new Error(d.error.message || JSON.stringify(d.error))) : res(d.result);
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP WebSocket 握手超时')), 10000);
  });

  return {
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => { try { ws.close(); } catch {} },
  };
}

/** 在指定标签页上开一个 session，用完即弃（不污染浏览器级连接） */
async function onTab(targetId, fn) {
  const cdp = await connect();
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return await fn(cdp, sessionId);
  } finally { cdp.close(); }
}

/**
 * 暴露给需要在一个标签页上连续发多条命令的场景（例如分块注入大文件）。
 * fn(cdp, sessionId)：cdp.send(method, params, sessionId)
 */
export async function withTab(targetId, fn) { return onTab(targetId, fn); }

export async function newTab(url = 'about:blank') {
  const cdp = await connect();
  try {
    // background:true → 不抢焦点
    const { targetId } = await cdp.send('Target.createTarget', { url, background: true });
    return targetId;
  } finally { cdp.close(); }
}

export async function closeTab(targetId) {
  const cdp = await connect();
  try { await cdp.send('Target.closeTarget', { targetId }); }
  catch {}
  finally { cdp.close(); }
}

export async function listTabs() {
  const cdp = await connect();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').map((t) => ({ id: t.targetId, url: t.url, title: t.title }));
  } finally { cdp.close(); }
}

/** 在标签页里求值。awaitPromise 必须开 —— eapi 调用是 async IIFE */
export async function evalIn(targetId, expression) {
  return onTab(targetId, async (cdp, sessionId) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error('页面内求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  });
}

export async function navigate(targetId, url) {
  return onTab(targetId, (cdp, sessionId) => cdp.send('Page.navigate', { url }, sessionId));
}

/**
 * 把标签页切到前台（会弹出窗口并抢一次焦点）。
 * 只在两种场景用：① 需要用户亲自登录/点击；② 后台限速导致异步轮询卡住时的兜底。
 * 自动化主路径不要调它 —— 那会破坏「不抢焦点」的承诺。
 */
export async function bringToFront(targetId) {
  return onTab(targetId, (cdp, sessionId) => cdp.send('Page.bringToFront', {}, sessionId));
}

export async function clickSelector(targetId, selector) {
  return onTab(targetId, (cdp, sessionId) =>
    cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`,
      returnByValue: true, awaitPromise: true,
    }, sessionId).then((r) => r.result?.value));
}

/** 往 <input type=file> 塞文件（微信读书传书页没有可点的上传按钮，只能走这条） */
export async function setFiles(targetId, selector, files) {
  return onTab(targetId, async (cdp, sessionId) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
    if (!nodeId) throw new Error(`找不到文件输入框：${selector}`);
    await cdp.send('DOM.setFileInputFiles', { nodeId, files }, sessionId);
    return files.length;
  });
}

/**
 * 真鼠标点击（派发 Input 事件序列，不是 el.click()）。
 * 亚马逊 Kindle 的「Deliver to device」是 React 的 div.action_button，
 * el.click() 完全点不动，必须走真实的鼠标事件。
 */
export async function clickAtSelector(targetId, selector) {
  return onTab(targetId, async (cdp, sessionId) => {
    const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    const r = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
    })()`);
    if (!r.result?.value) return 'not-found';
    const { x, y } = JSON.parse(r.result.value);
    const p = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, pointerType: 'mouse' };
    // 先 mouseMoved：部分 React 监听器只认带移动的完整序列
    await cdp.send('Input.dispatchMouseEvent', { ...p, type: 'mouseMoved', buttons: 0 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { ...p, type: 'mousePressed', buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { ...p, type: 'mouseReleased', buttons: 0 }, sessionId);
    return `clicked ${p.x},${p.y}`;
  });
}

/** 截图到本地文件。页面状态拿不准时先看真实画面，比反复查 DOM 快 */
export async function screenshot(targetId, outPath) {
  return onTab(targetId, async (cdp, sessionId) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(outPath, Buffer.from(data, 'base64'));
    return outPath;
  });
}

/** 读 cookie 名（走 Network.getCookies，能看到 httpOnly —— document.cookie 看不到） */
export async function getCookieNames(targetId, urls) {
  return onTab(targetId, async (cdp, sessionId) => {
    await cdp.send('Network.enable', {}, sessionId);
    const { cookies } = await cdp.send('Network.getCookies', { urls }, sessionId);
    return cookies.map((c) => c.name);
  });
}

/** 轮询等待条件成立，返回求值结果；超时抛错 */
export async function waitFor(targetId, expression, { timeout = 60000, interval = 1500, label = '条件' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await evalIn(targetId, expression); } catch (e) { last = 'eval-error: ' + e.message; }
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待「${label}」超时（${timeout}ms），最后取值：${String(last).slice(0, 200)}`);
}

// ---------------- CLI ----------------

async function cmdCheck() {
  const cfg = loadConfig();
  const b = resolveBrowser();
  const root = findSourceRoot();
  log('=== 专用浏览器实例自检 ===\n');
  log(`配置文件    : ${CONFIG_PATH} ${existsSync(CONFIG_PATH) ? '' : '（未创建，用默认值）'}`);
  if (b) {
    log(`浏览器      : ${b.bin}`);
    log(`身份        : ${b.kind}（来源 ${b.source}）`);
    log(`              ${b.kind === 'system'
      ? '系统浏览器 —— 可与日常 Chrome 同步登录态'
      : 'Playwright 自带 Chromium —— 不依赖用户装浏览器；登录态需在该实例内单独登录'}`);
  } else {
    log('浏览器      : ✗ 未找到');
    log(`              → 装一个 Chrome/Chromium，或执行：`);
    log(`                cd ${NODE_WORKSPACE} && npm i playwright && npx playwright install chromium`);
  }
  log(`专用 profile : ${cfg.profile_dir} ${existsSync(cfg.profile_dir) ? '✓ 已存在' : '(未创建，bootstrap 会建)'}`);
  log(`调试端口     : ${cfg.port}`);
  log(`下载目录     : ${getDownloadDir()}`);
  log(`登录态来源   : ${b?.kind === 'bundled'
    ? '不适用（Playwright Chromium 读不了日常 Chrome 的 cookie，需在实例内单独登录）'
    : root ? root + ' / ' + cfg.source_profile : '✗ 未找到日常 Chrome 数据目录'}`);

  const h = await health();
  if (h) log(`\n✓ 实例在运行：${h.browser}（端口 ${h.port}），WS 通道可用，无需任何授权`);
  else log(`\n· 实例未运行 —— 首次使用请跑 \`node cdp.mjs bootstrap\`，之后会自动拉起`);
  return 0;
}

async function cmdBootstrap() {
  const cfg = loadConfig();
  const b = resolveBrowser();
  log('=== 首次部署专用浏览器实例 ===\n');
  if (b) {
    log(`浏览器 : ${b.bin}`);
    log(`身份   : ${b.kind}（来源 ${b.source}）`);
    if (b.kind === 'bundled') {
      log('         Playwright 自带的 Chromium。它读不到日常 Chrome 的 cookie（密钥按 app 身份隔离），');
      log('         因此下面的核验里有站点会显示未登录 —— 那属于预期，按提示在该实例里登录一次即可。');
    }
    log(`profile: ${cfg.profile_dir}\n`);
  }
  if (!existsSync(cfg.profile_dir)) mkdirSync(cfg.profile_dir, { recursive: true });

  if (await isUp()) { await hideWindows(); log('· 实例已在运行，跳过拉起'); }
  else await ensureBrowser();     // 内部会同步登录态 + 清理缓存 + 拉起
  await applyDownloadBehavior();

  log('\n--- 登录态核验 ---');
  const checks = [
    ['Z-Library', 'https://z-lib.sk/', 'remix_userid', 'https://z-lib.sk'],
    ['微信读书', 'https://weread.qq.com/web/shelf', 'wr_vid', 'https://weread.qq.com'],
    ['亚马逊', 'https://www.amazon.com/', 'session-id', 'https://www.amazon.com'],
  ];
  let bad = 0;
  for (const [label, url, cookieName, cookieUrl] of checks) {
    const t = await newTab(url);
    try {
      await sleep(6000);
      const names = await getCookieNames(t, [cookieUrl]);
      const ok = names.includes(cookieName);
      log(`  ${ok ? '✓' : '✗'} ${label}`);
      if (!ok) {
        bad++;
        log(`      → 缺 ${cookieName}。先在专用实例里登录一次：`);
        log(`        node cdp.mjs new "${url}"   然后切到该窗口用鼠标登录`);
      }
    } catch (e) {
      bad++;
      log(`  ✗ ${label}（${e.message.slice(0, 60)}）`);
    } finally { await closeTab(t); }
  }
  await hideWindows();
  log(bad ? `\n完成，但有 ${bad} 个站点需要手动登录一次。` : '\n全部就绪。之后全流程无需任何人工介入。');
  return bad ? 1 : 0;
}

async function cmdEnsure() {
  const launched = await ensureBrowser();
  if (!launched) log('· 实例已在运行');
  await applyDownloadBehavior();
  await hideWindows();
  return 0;
}

async function cmdSyncCookies() {
  if (await isUp()) {
    warn('专用实例正在运行 —— 此时覆盖 Cookies 会被它退出时回写冲掉，已中止。');
    warn('先 `node cdp.mjs kill`，再重跑本命令。');
    return 1;
  }
  return syncCookies({ verbose: true }) ? 0 : 1;
}

async function releaseInstance({ quiet = false } = {}) {
  const cdp = await connect().catch(() => null);
  if (cdp) {
    try { await cdp.send('Browser.close'); } catch {}
    cdp.close();
  }
  // 必须等「实例真的没了 + 单例锁真的释放」再返回。
  // 只 sleep 1.5s 就返回是错的：紧接着的 ensureBrowser/launch 会 spawn 一个同 profile 的新
  // Chrome，撞上仍在退出中的旧实例的单例锁 → 新进程启动即 CHECK 崩溃，macOS 弹「意外退出」。
  // 2026-09-17 实测到过一次（21:02:23 崩溃 / 21:02:53 才拉起成功）。
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await sleep(500);
    if (!(await isUp()) && !liveSingletonPid()) break;
  }
  const owner = liveSingletonPid();
  const up = await isUp();
  if (!up) reapWatchdogs();     // 实例真没了，看门狗也没事可做
  if (quiet) return 0;
  if (up) log('· 实例仍在运行（可能有其它窗口），可手动退出');
  else if (owner) log(`· 实例已退出，单例锁仍挂在 pid ${owner}（残留，下次拉起会自动接管）`);
  else log('✓ 专用实例已停止 —— Chrome 的应用身份已还给日常浏览器');
  return 0;
}

async function cmdKill() { return releaseInstance(); }

async function cmdPrune() {
  if (await isUp()) {
    warn('实例正在运行，先 `node cdp.mjs kill` 再清理。');
    return 1;
  }
  const freed = pruneProfile({ verbose: true });
  log(freed.length ? '完成' : '无需清理');
  return 0;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const usage = `用法: node cdp.mjs <命令>

  check                     环境自检（Chrome / profile / 端口 / 登录态来源）
  bootstrap                 首次部署：建 profile + 迁登录态 + 拉起实例 + 核验三站点
  ensure                    确保实例就绪（没跑就自动拉起）
  sync-cookies              从日常 Chrome 重新同步登录态（实例须已停止）
  prune                     清理 profile 里的可再生缓存（实例须已停止）
  kill                      停止专用实例，把 Chrome 的应用身份还给日常浏览器
  watchdog                  内部用：空闲看门狗（实例常驻时自动让位，勿手动调）
  tabs                      列出标签页
  new <url>                 新建后台标签页（不抢焦点），输出 targetId
  eval <target> <expr>      在标签页里求值
  nav <target> <url>        导航
  front <target>            把标签页切到前台（会弹窗抢一次焦点，仅登录/卡住时用）
  show <target>             把窗口挪回屏幕内并置顶（需要用户亲自登录/操作时用）
  cookies <target> <url>    列出该站点的 cookie 名（含 httpOnly）
  click <target> <selector> 点击（JS el.click()）
  clickat <target> <selector> 真鼠标点击（派发 Input 事件，React 元素必须用这个）
  shot <target> <输出路径>  截图
  setfiles <target> <selector> <文件...>
  close <target>            关闭标签页

配置文件: ${CONFIG_PATH}`;

  // 除「管理实例本身」的命令外，其余命令都自动拉起实例。
  // 否则冷机状态下 `cdp.mjs new` 会直接报「实例未就绪」，破坏「零前置步骤」的承诺。
  const MANAGES_INSTANCE = new Set(['check', 'bootstrap', 'ensure', 'sync-cookies', 'prune', 'kill', 'watchdog']);
  if (cmd && !MANAGES_INSTANCE.has(cmd)) {
    await ensureBrowser({ quiet: true });
    // show 有意让窗口可见。CDP_NO_HIDE=1 供「用户正在手动登录/操作」期间临时关掉自动隐藏，
    // 否则后续任何一条 cdp.mjs 命令都会把用户正在填的窗口又挪到屏外。
    if (cmd !== 'show' && process.env.CDP_NO_HIDE !== '1') await hideWindows();
  }

  switch (cmd) {
    case 'check': return cmdCheck();
    case 'bootstrap': return cmdBootstrap();
    case 'ensure': return cmdEnsure();
    case 'sync-cookies': return cmdSyncCookies();
    case 'prune': return cmdPrune();
    case 'kill': return cmdKill();
    case 'watchdog': return cmdWatchdog(argv);
    case 'tabs': return log((await listTabs()).map((t) => `${t.id}\t${t.title}\t${t.url}`).join('\n'));
    case 'new': return log(await newTab(argv[0] || 'about:blank'));
    case 'eval': return log(String(await evalIn(argv[0], argv.slice(1).join(' ')))?.slice(0, 4000));
    case 'nav': await navigate(argv[0], argv[1]); return log('navigated');
    case 'front': await bringToFront(argv[0]); return log('前台');
    case 'show': return log('windowId=' + (await showWindow(argv[0])));
    case 'cookies': return log((await getCookieNames(argv[0], [argv[1]])).join(', '));
    case 'click': return log(await clickSelector(argv[0], argv[1]));
    case 'clickat': return log(await clickAtSelector(argv[0], argv[1]));
    case 'shot': return log(await screenshot(argv[0], argv[1]));
    case 'setfiles': return log(await setFiles(argv[0], argv[1], argv.slice(2)) + ' file(s)');
    case 'close': return closeTab(argv[0]);
    default: log(usage); process.exit(cmd ? 2 : 0);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { process.exitCode = (await main()) ?? 0; }
  catch (e) { warn(e.message); process.exitCode = 1; }
}
