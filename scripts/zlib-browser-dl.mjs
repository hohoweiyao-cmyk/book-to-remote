// ⚠️ 降级为「兜底脚本」（2026-09-16 重构）
//   正常请用 zlib-cdp.mjs：它复用用户已开的 Chrome 后台标签页，静默下载，不弹窗口、不抢焦点。
//   本脚本改用 Playwright 启动一个【非无头新 Chrome 窗口】来下载 —— 会弹窗抢占本机使用，只在
//   CDP 代理不可用时作为兜底。为什么不能无头：实测 bundled-chromium-headless 与 chrome-headless
//   都会拿到 "Try again later"（反爬识别），必须非无头真实 Chrome。
//
// zlib-browser-dl.mjs — 用 Playwright 过 Z-Library /dl 的 JS 盾并下载
// 用法: node zlib-browser-dl.mjs "<搜索词>" "<输出路径.epub>" [格式epub]
// playwright 加载：ESM 不吃 NODE_PATH，用 createRequire 从 workspace 解析主包（拿 chromium）
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { createRequire } from 'module';
import { join } from 'path';

let chromium;
try {
  const req = createRequire(join(homedir(), '.workbuddy/binaries/node/workspace/package.json'));
  ({ chromium } = req('playwright'));
} catch (e) {
  try {
    const req = createRequire(join(homedir(), '.workbuddy/binaries/node/workspace/package.json'));
    ({ chromium } = req('playwright-core'));
  } catch (e2) {
    console.error('未找到 playwright，请先安装: cd ~/.workbuddy/binaries/node/workspace && npm install playwright && npx playwright install chromium');
    process.exit(2);
  }
}

// 凭据来源：优先本 skill 的本地私有配置，其次 Z-Library.app 的配置
// —— 这样即使没装 APP 也能用（本地配置由 zlib-cdp.mjs login 生成）
const localCfgPath = homedir() + '/.workbuddy/zlibrary/config.local.json';
const appCfgPath = homedir() + '/Library/Application Support/z-library/config.json';
let uid, key, cfg = {};
if (existsSync(localCfgPath)) {
  const lc = JSON.parse(readFileSync(localCfgPath, 'utf8'));
  uid = lc?.credentials?.remix_userid;
  key = lc?.credentials?.remix_userkey;
  cfg = lc;
}
if ((!uid || !key) && existsSync(appCfgPath)) {
  const ac = JSON.parse(readFileSync(appCfgPath, 'utf8'));
  uid = uid || ac.remix_userid || ac.userid;
  key = key || ac.remix_userkey || ac.userkey;
  cfg.domains = ac.domains || [];
}
if (!uid || !key) {
  console.error('缺少凭据：请先运行 `node zlib-cdp.mjs login`（浏览器登录）或 `import-app`');
  process.exit(2);
}

const [query, outPath, format = 'epub'] = process.argv.slice(2);
if (!query || !outPath) {
  console.error('用法: node zlib-browser-dl.mjs "<搜索词>" "<输出路径>" [格式]');
  process.exit(2);
}

// 域名自适应：优先 env，其次从 app config 的 domains 里挑一个可用的（过滤 onion/books）
// 官方权威域名，已移除 z-library.ec（Cloudflare 标记为钓鱼）
const PREFERRED = ['z-lib.sk', 'z-lib.fm', 'z-library.sk', 'z-lib.gd', 'z-lib.gl', 'z-lib.do'];
const cfgDomains = (cfg.domains || []).filter((d) => !d.includes('.onion') && !d.includes('books'));
const candidateHosts = [...new Set([...(process.env.ZLIB_DOMAIN ? [process.env.ZLIB_DOMAIN] : []), ...PREFERRED, ...cfgDomains])];
let DOMAIN = null;
for (const h of candidateHosts) {
  const host = h.replace(/^https?:\/\//, '').replace(/\/$/, '');
  try {
    const r = await fetch(`https://${host}/`, { method: 'GET', redirect: 'manual' });
    if (r.status < 500) { DOMAIN = 'https://' + host; break; }
  } catch {}
}
if (!DOMAIN) throw new Error('无可用的 z-library 域名，请开启代理后重试，或用 ZLIB_DOMAIN 指定');
console.log('使用域名:', DOMAIN);

async function api(path, body) {
  const r = await fetch(DOMAIN + path, {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', remix_userid: String(uid), remix_userkey: String(key) },
  });
  return r.json();
}

// 1. 搜索选书
const msg = encodeURIComponent(query);
const s = await api(`/eapi/book/search?message=${msg}`, { count: 20, page: 1 });
if (s.success === false || !s.books?.length) throw new Error('搜索失败: ' + (s.error || '无结果'));
const cands = s.books.filter((b) => (b.extension || '').toLowerCase() === format);
if (!cands.length) throw new Error('没有 ' + format + ' 格式结果');
// 选书排序：优先「标题干净匹配 + 作者唯一/精确匹配」，降权套装/合著/大杂烩
// query 里的书名关键字（去掉"作者"部分，取前几个中文字/词作为标题锚）
const titleAnchor = query.replace(/[《》]/g, '').split(/\s+/)[0];
const score = (b) => {
  const t = (b.title || '').replace(/[《》]/g, '');
  const a = (b.author || '');
  let sc = 0;
  // 标题精确包含锚（且不含"套装/合集/思维定律/导读"等非单本词）
  if (t === titleAnchor) sc += 100;
  else if (t.startsWith(titleAnchor)) sc += 80;
  else if (t.includes(titleAnchor)) sc += 50;
  // 作者越短越纯粹（排除 & 多作者合著）
  if (!a.includes('&') && !a.includes('[') && a.length <= 20) sc += 30;
  // 降权套装/合集/导读/定律类大杂烩标题
  if (/套装|合集|定律|导读|手册|思维|10册|全\d+册/.test(t)) sc -= 60;
  // 精排小幅加分
  if (t.includes('精排')) sc += 5;
  return sc;
};
cands.sort((a, b) => score(b) - score(a));
const book = cands[0];
console.log(`选定: id=${book.id} hash=${book.hash} ${book.title} | ${book.author} | ${book.year} | ${book.extension} | ${(book.filesize / 1048576).toFixed(1)}MB`);

// 2. 详情拿 dl 链接
const d = await api(`/eapi/book/${book.id}/${book.hash}`);
const dl = d?.book?.dl;
if (!dl) throw new Error('详情无 dl 链接');
console.log('dl:', dl);

// 3. Playwright 下载（cookie 注入 + 自动过 JS 盾）
// 优先真实 Chrome 非无头（过反爬更稳），失败回退内置 chromium
let browser;
try {
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
} catch {
  browser = await chromium.launch({ headless: false });
}
const ctx = await browser.newContext({ acceptDownloads: true });
const cookieDomain = DOMAIN.replace(/^https?:\/\//, '').split('/')[0];
await ctx.addCookies([
  { name: 'remix_userid', value: String(uid), domain: cookieDomain, path: '/' },
  { name: 'remix_userkey', value: String(key), domain: cookieDomain, path: '/' },
]);
const page = await ctx.newPage();
try {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.goto(DOMAIN + dl, { waitUntil: 'domcontentloaded', timeout: 60000 }),
  ]);
  await download.saveAs(outPath);
  console.log('已保存:', outPath);
} catch (e) {
  // 若页面渲染为错误页而非触发下载，输出诊断
  const body = (await page.content()).slice(0, 400);
  throw new Error('下载事件未触发: ' + e.message + ' | 页面片段: ' + body.replace(/\s+/g, ' '));
} finally {
  await browser.close();
}

const st = statSync(outPath);
if (st.size < 10240) throw new Error('文件过小(' + st.size + 'B)，疑似错误页');
console.log(`✓ 完成 ${(st.size / 1048576).toFixed(1)}MB`);
