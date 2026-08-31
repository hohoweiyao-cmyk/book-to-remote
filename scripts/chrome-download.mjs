// 通过本机 Chrome (CDP) 下载 z-library 文件，绕过 curl 无法通过的 Cloudflare 反爬/浏览器校验。
// 用法: node chrome-download.mjs --url <download_url> --out <dir> [--name <filename>] [--port 9334]
import { readdirSync, statSync, existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function pick(flag, def) {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(flag + "="));
  return eq ? eq.split("=").slice(1).join("=") : def;
}
const URL = pick("--url");
const OUT = pick("--out", join(homedir(), "Downloads"));
const NAME = pick("--name");
const PORT = pick("--port", "9334");

if (!URL) { console.log(JSON.stringify({ ok: false, error: "缺少 --url" })); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}, sessionId = null) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    const msg = { id: mid, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error("timeout " + method)); } }, 90000);
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};

await new Promise((res) => (ws.onopen = res));

try {
  const { targetId } = await send("Target.createTarget", { url: URL, background: false });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

  // 关键：允许下载并指定保存目录（不强制文件名，避免 Chrome 改名冲突）
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: OUT }, sessionId).catch(() => {});

  // 预热：先访问 z-library 首页/书页取得 Cloudflare cf_clearance cookie，
  // 否则直接打 /dl/ 会被反爬 "Checking your browser" 拦截（curl 与无 cookie 浏览器均失败）。
  const warm = URL.replace(/\/dl\/.*/, "/");
  await send("Page.navigate", { url: warm }, sessionId).catch(() => {});
  await sleep(6000);
  // 再打真正的下载链接（此时已带 clearance cookie）
  await send("Page.navigate", { url: URL }, sessionId).catch(() => {});
  await sleep(3000);

  const before = new Set(existsSync(OUT) ? readdirSync(OUT) : []);
  let doneFile = null;
  const deadline = Date.now() + 85000;

  while (Date.now() < deadline) {
    await sleep(1500);
    const st = await send("Runtime.evaluate", {
      expression: "({url:location.href, title:document.title, body:(document.body?document.body.innerText:'').slice(0,140)})",
      returnByValue: true,
    }, sessionId).catch(() => ({}));
    const info = st.result?.result?.value;
    if (info && /login|登录|sign in/i.test(info.body + info.title) && !/download|downloading/i.test(info.url)) {
      console.log(JSON.stringify({ ok: false, error: "需要登录 z-library", page: info.url }));
      await send("Target.closeTarget", { targetId }).catch(() => {});
      ws.close(); process.exit(3);
    }
    const files = existsSync(OUT) ? readdirSync(OUT) : [];
    const added = files.filter((f) => !before.has(f) && !f.endsWith(".crdownload"));
    const partial = files.filter((f) => !before.has(f) && f.endsWith(".crdownload"));
    if (added.length) { doneFile = join(OUT, added[0]); break; }
    void partial;
  }

  if (!doneFile) {
    console.log(JSON.stringify({ ok: false, error: "下载未触发（可能反爬拦截或需登录）" }));
    await send("Target.closeTarget", { targetId }).catch(() => {});
    ws.close(); process.exit(4);
  }

  let finalName = doneFile;
  if (NAME && doneFile !== join(OUT, NAME)) {
    finalName = join(OUT, NAME);
    rmSync(finalName, { force: true });
    renameSync(doneFile, finalName);
  }
  const sz = statSync(finalName).size;
  console.log(JSON.stringify({ ok: true, file: finalName, size: sz }));
  await send("Target.closeTarget", { targetId }).catch(() => {});
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(5);
}
ws.close();
process.exit(0);
