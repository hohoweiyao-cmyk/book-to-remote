#!/usr/bin/env node
/**
 * zl-cdp-download.mjs — 直连用户 Chrome (CDP 9222) 在真实浏览器环境下载 Z-Library 电子书
 *
 * 原理：Z-Library 对 curl 有反爬盾（DiamWall/Cloudflare），但真实 Chrome 浏览器可正常通过。
 * 通过 Chrome 远程调试端口，在浏览器内完成：打开书详情页（过盾）→ 触发 eapi 下载 URL
 * （携带 app 的 remix 凭据，浏览器自动完成 302+cookie 跟随）→ Chrome 下载管理器保存文件。
 *
 * 用法（需在沙箱外运行）:
 *   node zl-cdp-download.mjs --slug 8Z9k4MWjyO --format epub --title "书名" \
 *        --uid <remix_userid> --key <remix_userkey> [--out ~/Downloads] [--domain z-library.ec]
 *
 * 成功时输出 JSON: {"ok":true,"file":"/path/to/file.epub","size":...}
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CHROME_PORT = 9222;
const DEVTOOLS_FILE = path.join(homedir(), "Library/Application Support/Google/Chrome/DevToolsActivePort");
const UA = null; // 使用浏览器自身 UA

function args() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : null; };
  return {
    slug: get("slug"), format: get("format") || "epub", title: get("title") || "book",
    uid: get("uid"), key: get("key"), out: get("out") || path.join(homedir(), "Downloads"),
    domain: get("domain") || "z-library.ec",
    timeout: Number(get("timeout") || 120),
  };
}

function sanitize(n) {
  return String(n).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);
}

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("WS 连接失败: " + (e.message || "")));
    setTimeout(() => reject(new Error("WS 连接超时")), 10000);
  });
}

function sendCDP(ws, sessions) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  return (method, params = {}, sessionId = null, timeoutMs = 30000) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      const m = { id: mid, method, params };
      if (sessionId) m.sessionId = sessionId;
      ws.send(JSON.stringify(m));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("CDP 超时: " + method)); } }, timeoutMs);
    });
}

function snapshotDir(dir) {
  const set = new Map();
  try { for (const f of readdirSync(dir)) { const p = path.join(dir, f); try { set.set(p, statSync(p).mtimeMs); } catch {} } } catch {}
  return set;
}

function newestIn(dir, exts, since) {
  let best = null;
  try {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (!exts.some((e) => f.toLowerCase().endsWith(e))) continue;
      const st = statSync(p);
      if (st.mtimeMs >= since && (!best || st.mtimeMs > statSync(best).mtimeMs)) best = p;
    }
  } catch {}
  return best;
}

async function main() {
  const opt = args();
  // 凭据缺省时自动从 Z-Library.app 配置读取（config.json 仅读 remix 字段，不外泄）
  if (!opt.uid || !opt.key) {
    try {
      const cfgPath = path.join(homedir(), "Library/Application Support/z-library/config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      opt.uid = opt.uid || cfg.remix_userid;
      opt.key = opt.key || cfg.remix_userkey;
    } catch {}
  }
  if (!opt.slug || !opt.uid || !opt.key) {
    console.log(JSON.stringify({ ok: false, error: "缺少参数: --slug 必填；uid/key 将从 app config 自动读取" }));
    process.exit(2);
  }

  // 1. 读 Chrome DevToolsActivePort 获取 browser WS 地址
  let wsUrl;
  try {
    const content = readFileSync(DEVTOOLS_FILE, "utf8").trim().split(/\r?\n/);
    wsUrl = `ws://127.0.0.1:${content[0]}${content[1] || "/devtools/browser"}`;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: "无法读取 Chrome 调试端口（Chrome 未开启远程调试）: " + e.message }));
    process.exit(3);
  }

  const ws = await wsConnect(wsUrl);
  const send = sendCDP(ws);

  // 2. 打开书详情页（过盾建立会话）
  const bookPageUrl = `https://${opt.domain}/book/${opt.slug}/`;
  const { targetId } = await send("Target.createTarget", { url: bookPageUrl, background: false }, null, 30000);
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }, null, 30000);

  // 等页面加载（最多 25s）
  await send("Page.enable", {}, sessionId, 10000);
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId, 5000);
      ready = r.result?.value === "complete" || r.result?.value === "interactive";
    } catch {}
  }

  // 3. 记录下载目录快照，然后触发下载
  const before = snapshotDir(opt.out);
  const dlUrl = `https://${opt.domain}/eapi/book/download?hash=${encodeURIComponent(opt.slug)}&format=${encodeURIComponent(opt.format)}&remix_userid=${encodeURIComponent(opt.uid)}&remix_userkey=${encodeURIComponent(opt.key)}`;

  // 浏览器内导航触发下载（自动跟随 302 + cookie）
  await send("Runtime.evaluate", {
    expression: `(function(){var a=document.createElement('a');a.href=${JSON.stringify(dlUrl)};a.download='';document.body.appendChild(a);a.click();return 'triggered';})()`,
    returnByValue: true,
  }, sessionId, 10000);

  // 4. 轮询等待新文件出现（含 .crdownload 中间态）
  const exts = ["." + opt.format.toLowerCase(), ".crdownload"];
  const start = Date.now();
  let file = null, stable = 0, lastSize = -1;
  while (Date.now() - start < opt.timeout * 1000) {
    await new Promise((r) => setTimeout(r, 1500));
    const candidate = newestIn(opt.out, exts, start - 5000) || newestIn(opt.out, ["." + opt.format.toLowerCase()], start - 5000);
    if (!candidate) continue;
    if (candidate.endsWith(".crdownload")) continue; // 还在下载
    const sz = statSync(candidate).size;
    if (sz > 1024 && sz === lastSize) { stable++; if (stable >= 2) { file = candidate; break; } }
    else { stable = 0; lastSize = sz; }
  }

  // 5. 关闭 tab
  try { await send("Target.closeTarget", { targetId }, null, 10000); } catch {}
  ws.close();

  if (!file) {
    console.log(JSON.stringify({ ok: false, error: "超时未检测到下载完成的新文件", outDir: opt.out }));
    process.exit(4);
  }

  // 6. 重命名为规范名
  const targetName = path.join(opt.out, sanitize(opt.title) + "." + opt.format);
  if (path.basename(file) !== path.basename(targetName)) {
    try { execFileSync("/bin/mv", [file, targetName]); file = targetName; } catch {}
  }
  console.log(JSON.stringify({ ok: true, file, size: statSync(file).size }));
}

main().catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
