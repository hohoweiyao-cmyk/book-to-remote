#!/usr/bin/env node
/**
 * ebook-format.mjs — 电子书容器的「按内容判定」层
 *
 * 被 verify-ebook.mjs（交付前校验）与 zlib-cdp.mjs（下载落盘关卡）共用，
 * 避免两处各写一份判定而在某一边漏掉某个格式。
 *
 * 核心立场：**格式由文件内容决定，不由扩展名决定。**
 * 反爬/限流页面经常被浏览器原样落盘成 `.epub`，只看扩展名必然漏网。
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const UNZIP = '/usr/bin/unzip';
export const MAX_KINDLE_WEB = 200 * 1024 * 1024;
export const MAX_KINDLE_MAIL = Math.round(5.25 * 1024 * 1024);   // 实测的邮件附件真实上限

/** 各内容容器允许的扩展名。用于发现「扩展名说谎」，而不是拿扩展名当判据。 */
export const ALLOWED_EXT = {
  epub: ['epub'],
  zip: ['epub', 'zip'],
  pdf: ['pdf'],
  mobi: ['mobi', 'azw3', 'azw', 'azw4', 'prc', 'pdb'],
  txt: ['txt'],
  text: ['txt'],
  html: [],
};

/** 读文件头若干字节（不整文件读入，大文件也不吃亏） */
export function readHead(file, n = 1024) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const ZIP_MAGIC = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b
  && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);

/**
 * 只依据文件头判断真实格式。
 * 判定顺序有讲究：**HTML 必须排在 ZIP 与 MOBI 之前**，
 * 因为错误页可能被包成压缩包下发，也可能被误认成其它容器。
 */
export function sniff(head) {
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';

  const probe = head.subarray(0, 512).toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (/^<!doctype\s+html/.test(probe) || /^<html[\s>]/.test(probe) || /^(<\?xml[^>]*\?>\s*)?<html[\s>]/.test(probe)) return 'html';

  // PalmDoc(PDB) 容器：偏移 60 起是 "BOOKMOBI"
  if (head.length >= 68
      && head.subarray(60, 64).toString('latin1') === 'BOOK'
      && head.subarray(64, 68).toString('latin1') === 'MOBI') return 'mobi';

  if (ZIP_MAGIC(head)) return 'zip';
  if (head.length && !head.subarray(0, 256).includes(0x00)) return 'text';
  return 'unknown';
}

/**
 * EPUB 开放容器（OCF）校验。
 * 依据 EPUB 规范：ZIP 内必须有 `mimetype`（内容恰为 application/epub+zip）
 * 与 `META-INF/container.xml`。最后跑一遍 CRC 测试抓截断。
 */
export function checkOcf(file) {
  let list;
  try {
    list = execFileSync(UNZIP, ['-Z1', file], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return { ok: false, why: '无法读取 ZIP 目录（文件损坏或不是 ZIP）' };
  }
  const names = list.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.includes('mimetype')) {
    return { ok: false, why: '是 ZIP 但缺少 mimetype 条目 —— 不是 EPUB（可能是普通压缩包）' };
  }
  if (!names.includes('META-INF/container.xml')) {
    return { ok: false, why: '缺少 META-INF/container.xml —— 不是合法的 EPUB 容器' };
  }
  let mime = '';
  try {
    mime = execFileSync(UNZIP, ['-p', file, 'mimetype'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 }).toString().trim();
  } catch {
    return { ok: false, why: '无法读取 mimetype 条目' };
  }
  if (mime !== 'application/epub+zip') {
    return { ok: false, why: `mimetype 内容不是 application/epub+zip（实际：${JSON.stringify(mime.slice(0, 60))}）` };
  }
  try {
    execFileSync(UNZIP, ['-t', file], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return { ok: false, why: 'ZIP 条目 CRC 校验失败 —— 文件损坏或被截断' };
  }
  return { ok: true };
}

/** 流式计算 SHA-256 */
export function sha256(file) {
  const h = createHash('sha256');
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * 一站式：嗅探 + 容器校验。
 * 返回 { ok, family, validation, issues[] }，调用方只负责按业务语义补充问题。
 *
 * validation 分级（**绝不谎报**）：
 *   ocf_container  EPUB 容器结构完整（mimetype 正确 + container.xml 存在 + CRC 全通过）
 *   magic_only     仅文件头魔数匹配（PDF / MOBI / AZW3 / 纯文本）
 *   needs_review   无法归类，必须人工检查
 */
export function inspectContainer(file) {
  const issues = [];
  if (!existsSync(file)) return { ok: false, family: 'unknown', validation: 'needs_review', issues: ['文件不存在'] };
  const st = statSync(file);
  if (!st.isFile()) return { ok: false, family: 'unknown', validation: 'needs_review', issues: ['不是普通文件'] };
  if (st.size === 0) return { ok: false, family: 'unknown', validation: 'needs_review', issues: ['文件为空 (0 字节)'] };

  const raw = sniff(readHead(file, 1024));
  let family = raw;
  let validation = 'needs_review';

  switch (raw) {
    case 'html':
      issues.push('内容是网页(HTML)而不是电子书 —— 这是反爬/限流/登录跳转页被当成书落盘了。'
        + '不要重试下载同一个链接，应先换域名或稍后再试（见 SKILL.md 步骤 4）。');
      break;

    case 'zip': {
      const ocf = checkOcf(file);
      if (ocf.ok) { family = 'epub'; validation = 'ocf_container'; }
      else { family = 'zip'; issues.push(`EPUB 容器校验未通过：${ocf.why}`); }
      break;
    }

    case 'mobi':
      // MOBI / AZW3 是 PalmDoc(PDB) 容器，**不是 ZIP**，绝不能用 unzip 去校。
      validation = 'magic_only';
      break;

    case 'pdf':
      validation = 'magic_only';
      break;

    case 'text':
      family = 'txt';
      if (st.size < 100) issues.push('文本文件过小，疑似空文件');
      validation = 'magic_only';
      break;

    default:
      family = 'unknown';
      issues.push('无法识别的文件格式（文件头不匹配任何已知容器）—— 需人工检查');
  }

  return { ok: issues.length === 0, family, validation, issues, size: st.size, raw };
}
