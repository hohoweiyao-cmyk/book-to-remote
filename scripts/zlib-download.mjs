#!/usr/bin/env node
/**
 * zlib-download.mjs — Z-Library 搜索/下载助手
 *
 * 复用用户 Z-Library.app (Electron) 的登录凭据（remix_userid/remix_userkey），
 * 通过 z-library eapi 完成搜索与下载，零第三方依赖（走系统 curl）。
 *
 * 用法：
 *   node zlib-download.mjs check                        # 环境自检：凭据/域名/网络通道
 *   node zlib-download.mjs search "<query>" [--count N] [--format epub|mobi|azw3|pdf]
 *   node zlib-download.mjs download --hash <hash> [--format epub] [--out <dir>] [--title <name>]
 *
 * 环境变量：
 *   ZLIB_DOMAIN    手动指定域名（默认从 app config 探测）
 *   ZLIB_PROXY     手动指定代理（默认自动探测直连/env/scutil/常见端口）
 */

import { execFileSync, execFile } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, createWriteStream, statSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(
  homedir(),
  "Library/Application Support/z-library/config.json"
);
const APP_PATH = "/Applications/Z-Library.app";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const PREFERRED_DOMAINS = [
  "z-library.ec", "1lib.sk", "z-lib.sk", "z-library.sk", "z-lib.do", "z-lib.gd",
  "z-lib.fm", "z-lib.gl", "z-lib.bz", "z-lib.fo",
];
const COMMON_PORTS = [7890, 7897, 1080, 1087, 8888, 10809, 2080, 6152, 58349];

// ---------------- 基础工具 ----------------

function log(msg) {
  process.stdout.write(msg + "\n");
}
function warn(msg) {
  process.stderr.write("[warn] " + msg + "\n");
}

function maskKey(k) {
  if (!k) return "(missing)";
  return k.slice(0, 4) + "****" + k.slice(-4);
}

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

// ---------------- 配置读取 ----------------

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { error: `未找到 Z-Library 凭据文件: ${CONFIG_PATH}\n请先运行 Z-Library.app 并登录一次（菜单/设置里登录账号）。` };
  }
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const domains = (cfg.domains || [])
      .filter((d) => !d.includes(".onion") && !d.includes("books"))
      .filter((d) => /^[a-z0-9.-]+$/.test(d));
    return {
      uid: cfg.remix_userid,
      key: cfg.remix_userkey,
      domains: [...new Set([...PREFERRED_DOMAINS, ...domains])],
      email: cfg.email,
      raw: cfg,
    };
  } catch (e) {
    return { error: `读取凭据失败: ${e.message}` };
  }
}

// ---------------- 网络通道检测 ----------------

function execCurl(url, { proxy, timeout = 12, headers = [], method = "GET", body = null, follow = false } = {}) {
  const args = ["-s", "-m", String(timeout)];
  if (proxy) args.push("-x", proxy);
  if (follow) args.push("-L");
  args.push("-A", UA);
  for (const h of headers) args.push("-H", h);
  if (body) args.push("--data-raw", body);
  else if (method === "POST") args.push("-X", "POST");
  args.push(url);
  try {
    return execFileSync("/usr/bin/curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeout * 1000 + 5000 });
  } catch (e) {
    return null;
  }
}

function runCurl(url, outFile, { proxy, timeout = 60, cookieJar } = {}) {
  const args = ["-sS", "-L", "-m", String(timeout), "-A", UA];
  if (proxy) args.push("-x", proxy);
  if (cookieJar) { args.push("-c", cookieJar, "-b", cookieJar); }
  args.push("-o", outFile, url);
  return new Promise((resolve) => {
    execFile("/usr/bin/curl", args, { timeout: timeout * 1000 + 10000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, err: stderr?.slice(0, 200) } : { ok: true });
    });
  });
}

function detectEnvProxy() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  return p || null;
}

function detectSystemProxy() {
  try {
    const out = execFileSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8" });
    const socks = out.match(/SOCKSProxy\s*:\s*(\S+)/)?.[1];
    const socksPort = out.match(/SOCKSPort\s*:\s*(\d+)/)?.[1];
    const httpProxy = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const httpPort = out.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
    if (socks && socksPort) return `socks5://${socks}:${socksPort}`;
    if (httpProxy && httpPort) return `http://${httpProxy}:${httpPort}`;
  } catch {}
  return null;
}

async function detectPortProxy() {
  const results = await Promise.all(
    COMMON_PORTS.map(
      (p) =>
        new Promise((resolve) => {
          execFile("/bin/nc", ["-z", "-w", "1", "127.0.0.1", String(p)], (err) =>
            resolve(err ? null : p)
          );
        })
    )
  );
  const open = results.find(Boolean);
  return open ? { http: `http://127.0.0.1:${open}`, port: open } : null;
}

async function probeDomain(domain, proxy) {
  return new Promise((resolve) => {
    const args = ["-s", "-m", "8", "-A", UA, "-o", "/dev/null", "-w", "%{http_code}"];
    if (proxy) args.push("-x", proxy);
    args.push(`https://${domain}/`);
    execFile("/usr/bin/curl", args, (err, stdout) => {
      if (err) return resolve(false);
      const code = stdout.trim();
      resolve(["200", "301", "302", "403"].includes(code));
    });
  });
}

async function detectChannel() {
  const channels = [];
  // 1. 直连
  channels.push({ name: "直连", proxy: null });
  // 2. env 代理
  const envProxy = detectEnvProxy();
  if (envProxy) channels.push({ name: `环境变量 ${envProxy}`, proxy: envProxy });
  // 3. 系统代理
  const sysProxy = detectSystemProxy();
  if (sysProxy) channels.push({ name: `系统代理 ${sysProxy}`, proxy: sysProxy });
  // 4. 常见本地端口
  const portProxy = await detectPortProxy();
  if (portProxy) channels.push({ name: `本地端口 :${portProxy.port}`, proxy: portProxy.http });

  return channels;
}

async function pickDomainAndChannel(cfg, forcedProxy) {
  const channels = forcedProxy
    ? [{ name: `手动 ${forcedProxy}`, proxy: forcedProxy }]
    : await detectChannel();

  // 并行探测 (通道 × 域名) 组合，找第一个可达的
  const combos = [];
  for (const ch of channels) {
    for (const d of cfg.domains.slice(0, 6)) {
      combos.push({ domain: d, channel: ch });
    }
  }
  const results = await Promise.all(
    combos.map(async (c) => ({ c, ok: await probeDomain(c.domain, c.channel.proxy) }))
  );
  const hit = results.find((r) => r.ok);
  return hit ? hit.c : null;
}

// ---------------- eapi 调用 ----------------

function eapiSearch(domain, channel, query, count) {
  // 关键：message 必须放在 query string（body 里的 message 会被忽略/返回推荐书单）
  const base = `https://${domain}/eapi/book/search?message=${encodeURIComponent(query)}`;
  const headers = ["Content-Type: application/json", "Accept: application/json"];
  const payload = JSON.stringify({ count: Math.min(count || 20, 50), page: 1 });
  let raw = execCurl(base, { proxy: channel.proxy, headers, method: "POST", body: payload, timeout: 15 });
  if (raw === null) {
    raw = execCurl(base, { proxy: channel.proxy, headers, timeout: 15 });
  }
  if (raw === null) return { error: "请求超时/网络不可达" };
  try {
    const j = JSON.parse(raw);
    if (j.success === false || j.success === 0) return { error: j.error || j.message || "搜索失败" };
    const books = j.books || [];
    return { books };
  } catch {
    return { error: "响应非 JSON（可能是验证码/跳转/反爬）" };
  }
}

async function eapiDownload(domain, channel, { hash, format, uid, key, outDir, title }) {
  const url = `https://${domain}/eapi/book/download?hash=${encodeURIComponent(hash)}&format=${encodeURIComponent(format || "")}&remix_userid=${encodeURIComponent(uid || "")}&remix_userkey=${encodeURIComponent(key || "")}`;

  // 第一步：请求拿 302（Location 隐藏 auth 参数，Set-Cookie 下发 remix 凭据）
  const jar = path.join(tmpdir(), "zl-cookies-" + process.pid + ".jar");
  const hdrFile = path.join(tmpdir(), "zl-hdr-" + process.pid + ".txt");
  const step1 = await new Promise((resolve) => {
    execFile("/usr/bin/curl", ["-s", "-m", "25", "-c", jar, "-D", hdrFile, "-o", "/dev/null", "-A", UA, url], (err) => resolve(!err));
  });
  let finalUrl = null;
  try {
    const hdr = readFileSync(hdrFile, "utf8");
    const status = (hdr.match(/^HTTP.*?(\d{3})/m) || [])[1];
    const loc = (hdr.match(/location:\s*(.+)/i) || [])[1];
    if (loc) finalUrl = loc.trim();
    else if (status && status.startsWith("4") || status && status.startsWith("5")) {
      // 无重定向且 4xx/5xx：读取错误体
      const body = execCurl(url, { proxy: channel.proxy, timeout: 15 });
      if (body) {
        try { const j = JSON.parse(body); if (j.error) return { error: j.error }; } catch {}
      }
      return { error: `HTTP ${status}` };
    }
  } catch {}

  // 第二步：跟随 Location（带 cookie）下载
  const target = finalUrl || url;
  const ext = format || path.extname(new URL(target).pathname).replace(".", "") || "bin";
  const fname = sanitize(title || hash) + "." + ext;
  mkdirSync(outDir, { recursive: true });
  const fpath = path.join(outDir, fname);
  const res = await runCurl(target, fpath, { proxy: channel.proxy, timeout: 120, cookieJar: jar });
  try { rmSync(jar, { force: true }); rmSync(hdrFile, { force: true }); } catch {}
  if (!res.ok) return { error: "下载失败: " + res.err };
  const sz = statSync(fpath).size;
  if (sz < 1024) {
    // 可能是 JSON 错误体
    const body = readFileSync(fpath, "utf8");
    if (body.startsWith("{")) {
      try { const j = JSON.parse(body); return { error: j.error || j.message || "下载被拒绝" }; } catch {}
    }
    return { error: "文件过小，疑似错误页/空文件", file: fpath };
  }
  return { file: fpath, size: sz };
}

// ---------------- CLI ----------------

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const cfg = loadConfig();
  if (cfg.error) return fail(cfg.error);
  const forcedProxy = process.env.ZLIB_PROXY || null;
  // 手动指定域名（跳过探测）
  if (process.env.ZLIB_DOMAIN) {
    cfg.domains = [process.env.ZLIB_DOMAIN, ...cfg.domains.filter((d) => d !== process.env.ZLIB_DOMAIN)];
  }

  if (cmd === "check") {
    log(`Z-Library.app : ${existsSync(APP_PATH) ? "已安装" : "未安装 (/Applications/Z-Library.app)"}`);
    log(`凭据          : userid=${cfg.uid || "(missing)"} key=${maskKey(cfg.key)}`);
    log(`可用域名      : ${cfg.domains.slice(0, 8).join(", ")}...`);
    const channels = await detectChannel();
    log(`候选网络通道  : ${channels.length ? channels.map((c) => c.name).join(" | ") : "无（直连可能被墙）"}`);
    const hit = await pickDomainAndChannel(cfg, forcedProxy);
    if (hit) {
      log(`✓ 可用通道    : ${hit.channel.name} + ${hit.domain}`);
      return;
    }
    warn("所有通道均无法访问 z-library。请先开启代理工具（Clash/V2Ray 等）后重试，");
    warn("或用 ZLIB_PROXY=http://127.0.0.1:<port> 指定代理。");
    process.exit(3);
  }

  if (cmd === "search") {
    const query = args.slice(1).find((a) => !a.startsWith("--")) || "";
    const count = Number(args.find((a) => a.startsWith("--count"))?.split("=")[1] || args[args.indexOf("--count") + 1] || 20);
    const fmt = (args.find((a) => a.startsWith("--format"))?.split("=")[1] || args[args.indexOf("--format") + 1] || "").toLowerCase();
    if (!query) return fail("用法: node zlib-download.mjs search \"书名或作者或ISBN\" [--count 20] [--format epub]");
    const hit = await pickDomainAndChannel(cfg, forcedProxy);
    if (!hit) return fail("无可用网络通道，请先开启代理（见 check 输出）");
    log(`通道: ${hit.channel.name} → ${hit.domain}`);
    const r = await eapiSearch(hit.domain, hit.channel, query, count);
    if (r.error) return fail(r.error);
    if (!r.books.length) return fail("无结果");
    log(`共 ${r.books.length} 条结果:`);
    r.books.forEach((b, i) => {
      const okFmt = !fmt || (b.extension || "").toLowerCase() === fmt;
      log(
        `${String(i + 1).padStart(2)}. [${okFmt ? "✓" : " "}] ${b.title || "?"} | ${b.author || "?"} | ${b.year || "?"} | ${(b.extension || "?").toLowerCase()} | ${b.language || "?"} | ${b.filesize ? (b.filesize / 1048576).toFixed(1) + "MB" : "?"} | hash=${b.hash}`
      );
    });
    return;
  }

  if (cmd === "download") {
    const hash = args.find((a) => a.startsWith("--hash"))?.split("=")[1] || args[args.indexOf("--hash") + 1];
    const format = (args.find((a) => a.startsWith("--format"))?.split("=")[1] || args[args.indexOf("--format") + 1] || "").toLowerCase();
    const title = args.find((a) => a.startsWith("--title"))?.split("=")[1] || args[args.indexOf("--title") + 1] || hash;
    const outDir = args.find((a) => a.startsWith("--out"))?.split("=")[1] || args[args.indexOf("--out") + 1] || path.join(homedir(), "Downloads");
    if (!hash) return fail("用法: node zlib-download.mjs download --hash <hash> [--format epub] [--out <dir>] [--title <name>]");
    const hit = await pickDomainAndChannel(cfg, forcedProxy);
    if (!hit) return fail("无可用网络通道，请先开启代理（见 check 输出）");
    log(`通道: ${hit.channel.name} → ${hit.domain}`);
    const r = await eapiDownload(hit.domain, hit.channel, {
      hash, format, uid: cfg.uid, key: cfg.key, outDir, title,
    });
    if (r.error) return fail(r.error, r.file ? { file: r.file } : undefined);
    log(`✓ 已保存: ${r.file} (${(r.size / 1048576).toFixed(1)} MB)`);
    return;
  }

  fail("未知命令。用法: check | search | download");
}

function fail(msg, extra) {
  warn(msg);
  if (extra?.file) log(`部分文件: ${extra.file}`);
  process.exit(1);
}

main().catch((e) => {
  warn("运行错误: " + e.message);
  process.exit(1);
});
