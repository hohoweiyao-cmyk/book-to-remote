#!/usr/bin/env node
/**
 * verify-ebook.mjs — 电子书文件验证
 *
 * 上传微信读书/Kindle 前必须验证，避免上传损坏/错误文件。
 *
 * 用法:
 *   node verify-ebook.mjs <file>
 * 输出 JSON: { ok, file, ext, size, issues[] }
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const WE_READ_OK = ["epub", "mobi", "azw3", "txt", "pdf", "doc", "docx", "umd"];
const KINDLE_WEB_OK = ["epub", "pdf", "doc", "docx", "txt"]; // Send to Kindle 网页版禁 mobi/azw3
const MAX_KINDLE_SIZE = 200 * 1024 * 1024; // 200MB

function main() {
  const file = process.argv[2];
  const out = { ok: true, file, issues: [] };

  if (!file) return die("用法: node verify-ebook.mjs <file>");
  if (!existsSync(file)) return die(`文件不存在: ${file}`);

  const st = statSync(file);
  out.size = st.size;
  out.ext = path.extname(file).toLowerCase().replace(".", "");

  if (st.size === 0) out.issues.push("文件为空 (0 字节)");
  if (st.size > MAX_KINDLE_SIZE) out.issues.push(`超过 Send to Kindle 200MB 上限 (${(st.size / 1048576).toFixed(0)}MB)`);

  if (!WE_READ_OK.includes(out.ext)) out.issues.push(`微信读书可能不支持 .${out.ext}`);

  switch (out.ext) {
    case "epub":
    case "mobi":
    case "azw3": {
      // EPUB/MOBI/AZW3 本质是 ZIP
      try {
        execFileSync("/usr/bin/unzip", ["-t", file], { stdio: "pipe" });
      } catch {
        out.issues.push("EPUB/ZIP 结构损坏或非有效容器");
      }
      break;
    }
    case "pdf": {
      const head = readFileSync(file).subarray(0, 8).toString("latin1");
      if (!head.startsWith("%PDF")) out.issues.push("非有效 PDF（魔数缺失）");
      break;
    }
    case "txt": {
      if (st.size < 100) out.issues.push("TXT 过小，疑似空文件");
      break;
    }
  }

  // HTML 错误页/下载失败页特征
  if (out.ext === "html" || out.ext === "htm") out.issues.push("是 HTML 页面而非电子书（可能下载到错误页）");

  out.ok = out.issues.length === 0;
  out.targets = {
    weread: out.ok || (out.issues.length === 1 && out.issues[0] === "微信读书可能不支持 ." + out.ext),
    kindle: out.ok && KINDLE_WEB_OK.includes(out.ext),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 2);
}

function die(msg) {
  console.log(JSON.stringify({ ok: false, issues: [msg] }, null, 2));
  process.exit(2);
}

main();
