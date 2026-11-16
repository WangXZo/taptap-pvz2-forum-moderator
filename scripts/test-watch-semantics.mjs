#!/usr/bin/env node
// 回归测试：守护循环的「每轮只处理一条」语义 + 失效配置清理（2026-11-13）
//
// 为什么要有这套测试（用户强烈纠正后补的护栏）：
//   答疑守护是**队列模式** —— 每轮只处理**队首一条**，没有「每轮 N 条」这概念。
//   但历史上残留了两处会让人误读的东西：
//     ① `config.collect.topN` 早已删除，代码却还在 `?? 8` 回落 → 看着像「一轮 8 条」
//     ② `match.maxAutoReplyPerRun`(8) 其实**只管手动单次跑 collect**，守护根本不读它
//   有人（包括 AI）照字面把「单轮 8 条」写进了给官方的文档 → 替官方虚构了承诺。
//
//   这套测试把「真实语义」钉死：谁再把失效配置加回来、或把守护改成批量，当场红。
//
// ⚠️ 检查「代码里不含某字符串」前必须**先剥注释** —— 因为我们在代码里留了
//    「config.collect.topN 已移除，别再加回来」这类**警示注释**，不剥会误报。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), 'utf8');

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name}${extra ? `  → ${extra}` : ''}`));

/**
 * 剥掉 JS 注释（行注释 // 与块注释 /* *\/），但**保留字符串/模板串内容**。
 * 用一个小型状态机，避免把字符串里的 `//`、或警示注释里的 `config.collect.topN` 误判。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let st = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += c; i++; continue; }
      if (c === '"') { st = 'dq'; out += c; i++; continue; }
      if (c === '`') { st = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out += c; }
      i++; continue;
    }
    if (st === 'block') {
      if (c === '*' && d === '/') { st = 'code'; i += 2; continue; }
      i++; continue;
    }
    // 字符串/模板串内部：原样保留（含转义）
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code';
    out += c; i++; continue;
  }
  return out;
}

const watchSrc = stripComments(read('./watch.mjs'));
const collectSrc = stripComments(read('./collect.mjs'));
const fetchSrc = stripComments(read('./fetch-latest.mjs'));
const config = JSON.parse(read('./config.json'));

// ---------- 1. 失效配置 collect.topN 必须彻底清除 ----------
console.log('=== ① config.collect.topN 已移除，代码不得再读 ===');
ok('config.collect 里没有 topN 键', !Object.prototype.hasOwnProperty.call(config.collect || {}, 'topN'),
  `collect keys: ${Object.keys(config.collect || {}).join(',')}`);
ok('watch.mjs 代码不含 collect.topN', !watchSrc.includes('collect.topN'));
ok('collect.mjs 代码不含 collect.topN', !collectSrc.includes('collect.topN'));
ok('fetch-latest.mjs 代码不含 collect.topN', !fetchSrc.includes('collect.topN'));
// 连「?? 8」这种回落也不该再出现在这三个文件的取数逻辑里（TOP 现在统一 ?? 10）
ok('watch.mjs 不再用 ?? 8 回落', !/topN\s*\?\?\s*8/.test(watchSrc));

// ---------- 2. 守护循环：每轮只处理队首一条 ----------
console.log('\n=== ② 守护循环每轮只处理队首一条（不是批量）===');
ok('watch 取队首 queue[0]', watchSrc.includes('queue[0]'));
ok('watch 用 only:[head.id] 单帖处理', /only:\s*\[head\.id\]/.test(watchSrc));
ok('watch 处理完按 id 出队', /queue\s*=\s*queue\.filter/.test(watchSrc));
// 守护**不读**手动上限 maxAutoReplyPerRun（那是 collect 的事）
ok('watch 不读 maxAutoReplyPerRun', !watchSrc.includes('maxAutoReplyPerRun'),
  '守护循环不该有「每轮 N 条」上限');

// ---------- 3. 手动单次跑的上限仍在 collect（别误删）----------
console.log('\n=== ③ maxAutoReplyPerRun 只管手动单次跑 collect ===');
ok('collect 仍用 maxAutoReplyPerRun 做单轮上限', collectSrc.includes('maxAutoReplyPerRun'));
ok('config.match.maxAutoReplyPerRun 仍在', typeof config.match?.maxAutoReplyPerRun === 'number');

// ---------- 4. TOP 是「拉取窗口」，不是「回复条数」 ----------
console.log('\n=== ④ TOP = 拉取窗口（接口上限 10），与回复条数无关 ===');
ok('watch 的 TOP 用 ?? 10 且 Math.max(...,10)', /Math\.max\(Number\(top\s*\?\?\s*10\),\s*10\)/.test(watchSrc));
ok('collect 的 TOP 用 ?? 10 且 Math.max(...,10)', /Math\.max\(Number\(top\s*\?\?\s*10\),\s*10\)/.test(collectSrc));

// ---------- 5. 文档口径与代码一致（别再写「每轮 8 条」）----------
console.log('\n=== ⑤ 运维文档明写「守护没有每轮 N 条」===');
const ops = read('../references/ops.md');
ok('ops.md 说明守护每轮只处理队首一条', /每轮.*只处理队首一条|只处理队首一条/.test(ops));
ok('ops.md 说明 maxAutoReplyPerRun 只管手动跑', /只管手动|手动单次跑/.test(ops));
ok('ops.md 标注 collect.topN 已移除', /collect\.topN.*已移除|已移除.*collect\.topN/.test(ops));

// ---------- 6. collect 用到 node:path 函数必须真导入（2026-11-16 缺 resolve 真炸过）----------
console.log('\n=== ⑥ collect 用 resolve/join 等必须导入（防 ReferenceError）===');
for (const fn of ['resolve', 'join', 'dirname']) {
  const used = new RegExp('(?<![.\\w$])' + fn + '\\s*\\(').test(collectSrc);
  if (!used) continue;
  const imported = new RegExp("import\\s*{[^}]*\\b" + fn + "\\b[^}]*}\\s*from\\s*'node:path'").test(collectSrc);
  ok(`collect 用 ${fn}( 且已导入`, imported, '用了却没导入 → 运行时 ReferenceError');
}

// ---------- 结果 ----------
console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
