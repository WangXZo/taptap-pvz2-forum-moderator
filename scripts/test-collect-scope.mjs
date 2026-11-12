#!/usr/bin/env node
// 回归测试：静态作用域守卫 —— 抓「定义在 A 块、却被兄弟块 B 引用」的变量（2026-11-12）
//
// 为什么需要：collect.mjs 2000+ 行、几十个 if 兄弟块，已经因此翻车两次：
//   · `shares is not defined`（3d 块里的变量被 3e 块用）
//   · `sceneGateOf is not defined`（3d 块里的 sceneGateOf/sfCfg 被 3e 安慰块用）
//     → 线上每条都报「[处理] 异常」，答疑/夸码/撮合全废。
//   单测只测 lib 函数，覆盖不到「作用域」—— 23 个套件全绿也照样漏到线上。
//
// 做法：仓库零依赖，不装 eslint，自带一个够用的词法作用域分析器：
//   ① 抹掉注释/字符串/正则/模板串（保留长度与换行）→ 花括号计数才准
//   ② 按花括号建作用域树，记录每行所在的作用域链
//   ③ 每行的 const/let/var（含解构、裸声明 let m;）记进该行作用域
//   ④ 每个标识符引用，从作用域链最内层往外找绑定；找不到 → 跨块引用嫌疑
//   ⑤ 排除：import、函数/箭头/catch/方法简写的参数、全局白名单、属性访问、对象键
//   只报「本文件声明过、但引用处看不见」的名字 → 全局/拼写类问题不误报。
//
// 自检：内置一段「坏样本」，分析器必须能抓到；提升后的「好样本」必须干净。
// 防止分析器自己坏掉后变成「永远报干净」的摆设。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

const GLOBALS = new Set(
  ('console Math JSON Object Array String Number Boolean Date RegExp Error TypeError Map Set WeakMap WeakSet Promise Symbol BigInt ' +
    'process Buffer URL URLSearchParams fetch Headers Request Response FormData Blob AbortController AbortSignal TextDecoder ' +
    'TextEncoder Intl Reflect Proxy structuredClone crypto queueMicrotask setTimeout setInterval clearTimeout clearInterval ' +
    'setImmediate clearImmediate globalThis undefined NaN Infinity isNaN isFinite parseInt parseFloat encodeURIComponent ' +
    'decodeURIComponent encodeURI decodeURI escape unescape require module exports __dirname __filename ' +
    'Float32Array Uint8Array ArrayBuffer Int32Array')
    .split(' ')
);

function scanTemplate(src, start) {
  const n = src.length;
  let i = start + 1;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '`') { i = scanTemplate(src, i); continue; }
        if (d === '"' || d === "'") {
          let j = i + 1;
          while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === d) { j++; break; } j++; }
          i = j; continue;
        }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return n;
}

// 抹掉注释/字符串/正则/模板串，保留长度与换行 → 花括号计数才准
function mask(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const n = src.length;
  let i = 0;
  let prev = '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); const end = j < 0 ? n : j; blank(i, end); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; break; } j++; }
      blank(i, j); i = j; prev = 'x'; continue;
    }
    if (c === '`') { const end = scanTemplate(src, i); blank(i, end); i = end; prev = 'x'; continue; }
    if (c === '/' && (!prev || '=(,:[!&|?{};+-*%^~<>'.includes(prev) || /^(return|typeof|instanceof|in|of|case|do|else|yield|await|new|delete|void)$/.test(prev))) {
      let j = i + 1, inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; break; }
        else if (d === '\n') break;
        j++;
      }
      // 连标志位（g/i/m/s/u/y）一起抹掉，否则 'g' 会被当成标识符引用
      while (j < n && /[gimsuyd]/.test(src[j])) j++;
      blank(i, j); i = j; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

function analyzeSource(raw) {
  const m = mask(raw);
  const lines = m.split('\n');
  const rawLines = raw.split('\n');

  // ---- 作用域树 ----
  let nextId = 0;
  const scopes = new Map();
  scopes.set(0, { parent: null, names: new Map(), label: 'module' });
  const stack = [0];
  let cur = 0;
  const scopeAt = [0];
  for (let ln = 0; ln < lines.length; ln++) {
    for (const ch of lines[ln]) {
      if (ch === '{') {
        const id = ++nextId;
        scopes.set(id, { parent: cur, names: new Map(), label: rawLines[ln].trim().slice(0, 70) });
        stack.push(id);
        cur = id;
      } else if (ch === '}') {
        stack.pop();
        cur = stack.length ? stack[stack.length - 1] : 0;
      }
    }
    scopeAt[ln + 1] = cur;
  }

  const declaredEverywhere = new Map(); // name -> [{scope, line}]
  const declare = (name, scopeId, line) => {
    if (!name) return;
    if (!scopes.get(scopeId).names.has(name)) scopes.get(scopeId).names.set(name, line);
    if (!declaredEverywhere.has(name)) declaredEverywhere.set(name, []);
    declaredEverywhere.get(name).push({ scope: scopeId, line });
  };

  // ---- 外部名字：import / 参数 ----
  const external = new Set(GLOBALS);
  for (const mm of raw.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (mm[1]) external.add(mm[1]);
    if (mm[2]) for (const part of mm[2].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) external.add(t);
    }
  }
  // 参数表：函数声明 / 箭头函数 / catch / 对象方法简写
  // ⚠️ 不能用 `\(([^()]*)\)` —— 默认值里带括号（nowMs = Date.now()）会整段匹配失败。
  const matchParen = (s, open) => {
    let d = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  };
  const paramLists = [];
  for (const mm of m.matchAll(/\bfunction\b[^\n(]*\(/g)) {
    const open = mm.index + mm[0].length - 1;
    const close = matchParen(m, open);
    if (close > 0) paramLists.push(m.slice(open + 1, close));
  }
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== '(') continue;
    const close = matchParen(m, i);
    if (close < 0) continue;
    const after = m.slice(close + 1, close + 12);
    if (/^\s*=>/.test(after)) paramLists.push(m.slice(i + 1, close));
    else if (/catch\s*$/.test(m.slice(Math.max(0, i - 8), i))) paramLists.push(m.slice(i + 1, close));
  }
  // 对象字面量的方法简写：`set(k, v) { ... }` —— 名字是属性名，参数是方法的参数
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== '(') continue;
    const close = matchParen(m, i);
    if (close < 0) continue;
    if (!/^\s*\{/.test(m.slice(close + 1, close + 6))) continue;
    let k = i - 1;
    while (k >= 0 && /\s/.test(m[k])) k--;
    if (k < 0 || !/[A-Za-z_$0-9]/.test(m[k])) continue;
    while (k >= 0 && /[A-Za-z_$0-9]/.test(m[k])) k--;
    let j = k;
    while (j >= 0 && /\s/.test(m[j])) j--;
    const prev = j >= 0 ? m[j] : '';
    if (prev !== '{' && prev !== ',') continue;
    paramLists.push(m.slice(i + 1, close));
  }
  for (const p of paramLists) {
    for (const part of p.split(',')) {
      // 解构参数：{ post, flat, config } / { a: b } / [x, y]
      const t = part
        .trim()
        .replace(/^\.\.\./, '')
        .replace(/^[{[]/, '')
        .replace(/[}\]]$/, '')
        .split('=')[0]
        .trim()
        .split(':')
        .pop()
        .trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) external.add(t);
    }
  }

  // ---- 声明 ----
  for (let ln = 0; ln < lines.length; ln++) {
    const scopeId = scopeAt[ln];
    const text = lines[ln].replace(/^\s*export\s+/, '');
    let mm;
    for (const m2 of text.matchAll(/(?:^|[({;,])\s*(const|let|var)\s+(.+)$/g)) {
      const decls = m2[2];
      // 解构声明：const { a, b } = ... / for (const { item, scene } of ...)
      const dest = decls.match(/^\s*([{\[])([\s\S]*)$/);
      if (dest) {
        const inner = dest[2].replace(/[}\]][\s\S]*$/, '');
        for (const part of inner.split(',')) {
          const dm = part.match(/^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/);
          if (dm) declare(dm[2] || dm[1], scopeId, ln + 1);
        }
        continue;
      }
      for (const part of decls.split(',')) {
        // 名字后跟 `=` / `of` / `in`（有初始值），或直接到 `;`/行尾（`let m;` 裸声明）
        const dm = part.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:=|of\b|in\b|;|$)/);
        if (dm) declare(dm[1], scopeId, ln + 1);
      }
    }
    const fnRe = /(?:^|\s)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
    while ((mm = fnRe.exec(text))) declare(mm[1], scopeId, ln + 1);
    const clsRe = /(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g;
    while ((mm = clsRe.exec(text))) declare(mm[1], scopeId, ln + 1);
  }

  // ---- 引用检查 ----
  const issues = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const text = lines[ln];
    const scopeId = scopeAt[ln];
    const isImportLine = /^\s*import\b/.test(text);
    const declNames = new Set();
    for (const mm of text.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declNames.add(mm[1]);
    for (const mm of text.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of mm[1].split(',')) {
        const t = part.trim().split('=')[0].trim().replace(/^\.\.\./, '').split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) declNames.add(t);
      }
    }
    for (const mm of text.matchAll(/([A-Za-z_$][\w$]*)/g)) {
      const name = mm[1];
      const before = text[mm.index - 1];
      const after = text[mm.index + name.length];
      if (before === '.' || before === '?') continue;       // 属性访问
      if (after === ':' && before !== '?') continue;          // 对象键
      if (isImportLine && name === 'from') continue;          // import ... from
      if (declNames.has(name)) continue;                       // 本行声明
      if (external.has(name)) continue;                        // import / 参数 / 全局
      if (!declaredEverywhere.has(name)) continue;             // 本文件没声明过 → 外部来源，不管
      // 对象字面量的方法简写：`close() {}` —— close 是属性名，不是变量引用
      if (after === '(') {
        let j = mm.index - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        const prevChar = j >= 0 ? text[j] : '';
        if (prevChar === '{' || prevChar === ',') {
          const close = matchParen(text, mm.index + name.length);
          if (close > 0 && /^\s*\{/.test(text.slice(close + 1, close + 6))) continue;
        }
      }
      // 从内往外找绑定
      let s = scopeId, found = -1;
      while (s !== null && s !== undefined) {
        if (scopes.get(s).names.has(name)) { found = s; break; }
        s = scopes.get(s).parent;
      }
      if (found === -1) {
        const decls = declaredEverywhere.get(name);
        issues.push({
          line: ln + 1,
          name,
          text: rawLines[ln].trim().slice(0, 110),
          declLines: decls.map((d) => d.line),
          inBlock: scopes.get(scopeId).label,
        });
      }
    }
  }
  return issues;
}

// ---------- ① 自检：分析器自己必须能抓到「跨块引用」 ----------
console.log('=== ① 分析器自检 ===');
const BAD_SAMPLE = `
async function runOnce() {
  const state = {};
  if (true) {
    const sfCfg = { x: 1 };
    const gateOf = (s) => sfCfg.x;
    gateOf('a');
  }
  if (true) {
    const g = gateOf('comfort');
    console.log(g, sfCfg.x);
  }
}
runOnce();
`;
const badIssues = analyzeSource(BAD_SAMPLE);
check('坏样本：抓到跨块引用 gateOf', badIssues.some((i) => i.name === 'gateOf'));
check('坏样本：抓到跨块引用 sfCfg', badIssues.some((i) => i.name === 'sfCfg'));

const GOOD_SAMPLE = `
async function runOnce() {
  const state = {};
  const sfCfg = { x: 1 };
  const gateOf = (s) => sfCfg.x;
  if (true) {
    gateOf('a');
  }
  if (true) {
    const g = gateOf('comfort');
    console.log(g, sfCfg.x);
  }
}
runOnce();
`;
check('好样本：提升到函数体后不再误报', analyzeSource(GOOD_SAMPLE).length === 0);

// ---------- ② 扫描全部脚本 ----------
console.log('\n=== ② 全脚本作用域扫描 ===');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const files = walk(ROOT).sort();
let totalIssues = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const issues = analyzeSource(fs.readFileSync(f, 'utf8'));
  if (issues.length) {
    totalIssues += issues.length;
    check(`${rel} 作用域干净`, false, `${issues.length} 处跨块引用`);
    for (const it of issues) {
      console.log(`      L${it.line} 「${it.name}」声明在 L${it.declLines.join('/')}（别的块）→ ${it.text}`);
    }
  } else {
    check(`${rel} 作用域干净`, true);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（扫描 ${files.length} 个文件，跨块引用 ${totalIssues} 处）`);
if (fail) {
  console.log('\n修法：把被跨块引用的 const 提升到共同的函数体作用域（参考 collect.mjs 的 sfCfg/sceneGateOf）。');
  process.exit(1);
}
