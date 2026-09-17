// stk-drop.mjs — 分块注入文件到 Send to Kindle 页面并模拟 drop
// 用法: node stk-drop.mjs <targetId> <文件路径> [文件名]
// 依赖同目录的 cdp.mjs（自包含专用 Chrome 实例，不再走 web-access 代理）
import { readFileSync } from 'fs';
import { basename } from 'path';
import { withTab } from './cdp.mjs';

const [targetId, filePath, nameArg] = process.argv.slice(2);
if (!targetId || !filePath) {
  console.error('用法: node stk-drop.mjs <targetId> <文件路径> [文件名]');
  process.exit(2);
}

const buf = readFileSync(filePath);
const name = nameArg || basename(filePath);
const b64 = buf.toString('base64');
console.log(`file ${name} ${buf.length}B base64 ${(b64.length / 1048576).toFixed(1)}MB`);

// 整段注入复用同一条 CDP 连接与 session —— 6MB 书的 base64 有十几块，
// 每块单开一次连接会白付十几次握手开销。
const CHUNK = 700000;
const result = await withTab(targetId, async (cdp, sessionId) => {
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('页面内求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  await ev('window.__b64chunks = []; null');
  for (let i = 0; i < b64.length; i += CHUNK) {
    await ev(`window.__b64chunks.push(${JSON.stringify(b64.slice(i, i + CHUNK))}); null`);
    process.stdout.write(`\rchunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(b64.length / CHUNK)}`);
  }
  console.log();

  return ev(`(async () => {
    const b64 = window.__b64chunks.join('');
    window.__b64chunks = null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)}, {type: 'application/epub+zip'});
    const dt = new DataTransfer();
    dt.items.add(file);
    // 真实拖放区。旧版用 '[class*=s2k-dnd]' 会误匹配 .s2k-dnd-hero-image（装饰图），
    // drop 打到错误元素上却仍返回 "dropped"，属于静默失败。这里按优先级取最内层真容器。
    const zone = document.querySelector('#s2k-dnd-area')
      || document.querySelector('.s2k-dnd-box')
      || document.querySelector('.stk-dnd-home-functioning-area')
      || document.querySelector('.s2k-wrapper');
    if (!zone) return 'no-zone';
    const opts = {bubbles: true, cancelable: true, dataTransfer: dt};
    const targets = [zone, zone.parentElement].filter(Boolean);
    for (const t of targets) {
      t.dispatchEvent(new DragEvent('dragenter', opts));
      t.dispatchEvent(new DragEvent('dragover', opts));
      t.dispatchEvent(new DragEvent('drop', opts));
    }
    return 'dropped ' + file.name + ' ' + file.size + 'B -> ' + zone.id + '.' + zone.className;
  })()`);
});
console.log(result);
