#!/usr/bin/env node
// 答疑库条目格式校验（2026-11-25，CI 拦一道）
//
// 校验 qa/entries/*.md：
//   · frontmatter 必填字段齐全（id / question / keywords）
//   · id 唯一、且与文件名一致
//   · 关键词非空
//   · 要点格式正确（置信度 0~100，来源是 http(s) 链接）
//   · 没有明显隐私串（手机号 / 邮箱 / QQ 群）
//
// 用法：node scripts/qa-lint.mjs [--dir <目录>]
// 退出码：0 = 全过；1 = 有问题

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEntryFile } from './lib/qa-entry.mjs';

const argv = process.argv.slice(2);
const i = argv.indexOf('--dir');
const DIR = resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : 'qa/entries');

const problems = [];
function bad(file, msg) {
  problems.push(`${file}: ${msg}`);
}

let files = [];
try {
  files = (await readdir(DIR)).filter((f) => f.endsWith('.md'));
} catch {
  console.log(`✓ 条目目录不存在（${DIR}）—— 跳过`);
  process.exit(0);
}
if (!files.length) {
  console.log(`✓ 条目目录为空（${DIR}）—— 跳过`);
  process.exit(0);
}

const seenIds = new Map();
let claimTotal = 0;
let withSource = 0;

for (const f of files) {
  // ⚠️ 去 BOM：Windows 编辑器/Set-Content -Encoding UTF8 会写 BOM，
  //    带 BOM 会让 frontmatter 匹配失败（误报「缺少 frontmatter」）
  const raw = (await readFile(join(DIR, f), 'utf8')).replace(/^\uFEFF/, '');

  // frontmatter 必填
  if (!/^---\r?\n/.test(raw)) {
    bad(f, '缺少 frontmatter（--- 开头）');
    continue;
  }
  const e = parseEntryFile(raw);
  if (!e.id) bad(f, '缺 id');
  if (!e.question) bad(f, '缺 question');
  if (!e.keywords.length) bad(f, '缺 keywords（关键词是打分主依据，不能空）');
  if (e.confidence != null && (e.confidence < 0 || e.confidence > 100)) {
    bad(f, `confidence 越界：${e.confidence}`);
  }

  // id 唯一 + 与文件名一致
  const expectName = `${e.id}.md`;
  if (e.id && f !== expectName) bad(f, `id「${e.id}」与文件名不一致（应为 ${expectName}）`);
  if (e.id) {
    if (seenIds.has(e.id)) bad(f, `id 重复：「${e.id}」也在 ${seenIds.get(e.id)}`);
    else seenIds.set(e.id, f);
  }

  // 要点格式
  const hasClaimsSection = /^#{1,3}\s*要点\s*$/m.test(raw);
  if (hasClaimsSection) {
    if (!e.claims.length) bad(f, '有「## 要点」段但没解析出要点');
    for (const c of e.claims) {
      claimTotal++;
      if (c.confidence != null && (c.confidence < 0 || c.confidence > 100)) {
        bad(f, `要点置信度越界：${c.confidence}（${c.text.slice(0, 20)}）`);
      }
      for (const s of c.sources || []) {
        if (!/^https?:\/\//i.test(s)) bad(f, `来源不是链接：${s}`);
      }
    }
  }

  // 来源计数
  const srcs = new Set();
  if (e.source) srcs.add(e.source);
  for (const c of e.claims) for (const s of c.sources || []) srcs.add(s);
  if (srcs.size) withSource++;

  // 隐私
  // ⚠️ 先剥掉**公开服务联系方式** —— 「客服QQ：4008932088」「客服电话 400-xxx-xxxx」
  //    是给玩家的公开指引，不是玩家隐私，误报会让 CI 拦下正确内容。
  const publicContact = /(客服|官方|公众号|企业微信|客服电话|服务热线|官方电话)\s*(QQ|qq|群|电话|号码)?\s*[:：]?\s*[A-Za-z0-9-]{5,}/g;
  const cleaned = raw.replace(publicContact, '客服联系方式');
  const priv = [
    [/\b1[3-9]\d{9}\b/, '手机号'],
    [/[\w.+-]+@[\w-]+\.[\w.]{2,}/, '邮箱'],
    [/(?:QQ|qq)\s*(?:群)?\s*[:：]?\s*\d{5,}/, 'QQ号/群号'],
    [/\b(?:and|ios)[A-Za-z0-9]{8}\b/, '好友码'],
    [/\bJFA[A-Za-z0-9]{7}\b/, '天宫码'],
  ];
  for (const [re, what] of priv) {
    if (re.test(cleaned)) bad(f, `含${what}（提交前请脱敏）`);
  }
}

console.log(`条目 ${files.length} 个 · 要点 ${claimTotal} 个 · 有来源 ${withSource} 个`);
if (problems.length) {
  console.log(`\n❌ ${problems.length} 处问题：`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  if (problems.length > 40) console.log(`  …… 还有 ${problems.length - 40} 处`);
  process.exit(1);
}
console.log('✓ 格式校验通过');
