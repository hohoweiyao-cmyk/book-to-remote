#!/usr/bin/env node
/**
 * verify-ebook.mjs — 电子书交付前验证（**按内容判定，不靠扩展名**）
 *
 * 上传微信读书 / 投送 Kindle 前必须跑，避免把损坏文件、或「反爬错误页」
 * 当成书投出去。
 *
 * 用法:
 *   node verify-ebook.mjs <file> [--expect-size <bytes>] [--size-tolerance <0..1>]
 *
 * 输出 JSON:
 *   {
 *     ok, file, ext,
 *     format,                 // 由文件头嗅探出的真实格式
 *     ext_matches_content,    // 扩展名是否与内容相符（null = 无法判定）
 *     size, sha256,
 *     validation,             // 校验分级，绝不谎报
 *     size_check,             // 与服务端声明大小的比对结果（未传 --expect-size 时为 null）
 *     issues[], routing{}, targets{}
 *   }
 *
 * 校验分级（validation）：
 *   ocf_container  EPUB 容器结构完整（mimetype 正确 + container.xml 存在 + CRC 全通过）
 *   magic_only     仅文件头魔数匹配（PDF / MOBI / AZW3 / 纯文本）
 *   needs_review   无法归类，必须人工检查
 *
 * 退出码: 0 = 通过, 2 = 未通过
 *
 * ⚠️ 即便是 ocf_container，也只证明「容器结构完整」——不等于内容完整，
 * 不是 EPUBCheck，也不是病毒扫描。汇报时不得说成「已通过内容校验」。
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_EXT, MAX_KINDLE_WEB, MAX_KINDLE_MAIL,
  inspectContainer, sha256,
} from './ebook-format.mjs';

const WE_READ_OK = ['epub', 'mobi', 'azw3', 'txt', 'pdf', 'doc', 'docx', 'umd'];
const KINDLE_WEB_OK = ['epub', 'pdf', 'doc', 'docx', 'txt'];   // Send to Kindle 网页版禁 mobi/azw3
const KINDLE_MAIL_OK = ['epub', 'pdf', 'doc', 'docx'];

function main() {
  const argv = process.argv.slice(2);
  const flag = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const file = argv[0];

  const out = { ok: true, file, issues: [] };
  const emit = () => process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  const die = (msg) => { out.ok = false; out.issues.push(msg); emit(); process.exit(2); };

  if (!file || file.startsWith('--')) {
    return die('用法: node verify-ebook.mjs <file> [--expect-size <bytes>] [--size-tolerance <0..1>]');
  }
  if (!existsSync(file)) return die(`文件不存在: ${file}`);
  const st = statSync(file);
  if (!st.isFile()) return die(`不是普通文件: ${file}`);

  out.size = st.size;
  out.ext = path.extname(file).toLowerCase().replace('.', '');
  const extNorm = out.ext === 'htm' ? 'html' : out.ext;

  // --- 1) 内容嗅探 + 容器校验（全部委托给共用层） ---
  const insp = inspectContainer(file);
  out.issues.push(...insp.issues);
  out.validation = insp.validation;

  // MOBI 与 AZW3 共用 BOOKMOBI 魔数，靠扩展名细分；否则一律记 mobi。
  out.format = insp.raw === 'mobi'
    ? (['azw3', 'azw', 'azw4'].includes(extNorm) ? extNorm : 'mobi')
    : insp.family;

  const allowed = ALLOWED_EXT[insp.raw];
  out.ext_matches_content = allowed ? allowed.includes(extNorm) : null;

  const contentOk = insp.validation === 'ocf_container' || insp.validation === 'magic_only';

  // --- 2) 与服务端声明大小交叉比对（拦住截断下载与错误页） ---
  const expectRaw = flag('--expect-size');
  const tol = Math.max(0, Math.min(1, parseFloat(flag('--size-tolerance', '0.01')) || 0));
  if (expectRaw == null) {
    out.size_check = null;
  } else {
    const expect = Number(expectRaw);
    if (!Number.isFinite(expect) || expect <= 0) {
      out.issues.push(`--expect-size 取值非法：${expectRaw}`);
      out.size_check = null;
    } else {
      const delta = st.size - expect;
      const ratio = Math.abs(delta) / expect;
      const match = ratio <= tol;
      out.size_check = { expected: expect, actual: st.size, delta, ratio: Number(ratio.toFixed(6)), tolerance: tol, match };
      if (!match) {
        out.issues.push(`实际大小 ${st.size}B 与服务端声明 ${expect}B 不符（相差 ${delta > 0 ? '+' : ''}${delta}B，`
          + `${(ratio * 100).toFixed(2)}%）—— 极可能是截断下载或错误页，不要投送`);
      }
    }
  }

  // --- 3) 扩展名与内容不符 ---
  if (out.ext_matches_content === false) {
    out.issues.push(`扩展名 .${out.ext} 与实际内容(${out.format})不一致 —— 请确认是否下错文件`);
  }

  // --- 4) 体积 ---
  if (st.size > MAX_KINDLE_WEB) {
    out.issues.push(`超过 Send to Kindle 网页版 200MB 上限（${(st.size / 1048576).toFixed(0)}MB）`);
  }
  if (contentOk && !WE_READ_OK.includes(out.format)) out.issues.push(`微信读书可能不支持 .${out.format}`);

  // --- 5) SHA-256（供 .source.json 留痕，日后可核对） ---
  out.sha256 = sha256(file);

  // --- 6) 投送路由（集中判定，避免各处各判一套） ---
  out.routing = {
    weread: contentOk && WE_READ_OK.includes(out.format),
    kindle_mail: contentOk && KINDLE_MAIL_OK.includes(out.format) && st.size <= MAX_KINDLE_MAIL,
    kindle_web: contentOk && KINDLE_WEB_OK.includes(out.format) && st.size <= MAX_KINDLE_WEB,
  };
  // 兼容旧字段
  out.targets = { weread: out.routing.weread, kindle: out.routing.kindle_web };

  out.ok = out.issues.length === 0;
  emit();
  process.exit(out.ok ? 0 : 2);
}

main();
