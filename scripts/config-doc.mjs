#!/usr/bin/env node
// 配置参考文档生成器（2026-11-20 · T19）
//
// 为什么要有它：文档手写必然与代码脱节。这里从 scripts/config/schema.json
// **单向生成** docs/config-reference.md —— 改配置项只改 schema，文档自动跟上。
//
// 用法：
//   node scripts/config-doc.mjs              # 生成 docs/config-reference.md
//   node scripts/config-doc.mjs --check      # 只校验文档是否最新（CI/测试用），过期则 exit 1
//   node scripts/config-doc.mjs --out <path>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { SKILL_ROOT, argvOf } from './lib/paths.mjs';
import { loadSchema, listFields, diffExtraKeys } from './lib/config.mjs';

const { has, argOf } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const OUT = resolve(argOf('out', resolve(SKILL_ROOT, 'docs', 'config-reference.md')));
const schema = loadSchema();

const typeLabel = (def) => {
  if (def.enum) return `\`${def.enum.join(' | ')}\``;
  if (def.type === 'array') return '`array`';
  if (def.type === 'object') return '`object`';
  return `\`${def.type}\``;
};

const defaultLabel = (def) => {
  if (def.default === '') return '*(空)*';
  if (Array.isArray(def.default)) return def.default.length ? `\`${JSON.stringify(def.default)}\`` : '`[]`';
  if (def.default && typeof def.default === 'object') return `\`${JSON.stringify(def.default)}\``;
  return `\`${JSON.stringify(def.default)}\``;
};

const rangeLabel = (def) => {
  const parts = [];
  if (def.min !== undefined) parts.push(`≥ ${def.min}`);
  if (def.max !== undefined) parts.push(`≤ ${def.max}`);
  return parts.length ? parts.join('，') : '—';
};

function render() {
  const fields = listFields(schema);
  const L = [];
  L.push('# 配置参考');
  L.push('');
  L.push('> ⚠️ **本文件由 `node scripts/config-doc.mjs` 从 `scripts/config/schema.json` 自动生成，不要手改。**');
  L.push('> 要改默认值或加配置项 → 改 `schema.json` → 重跑生成脚本。');
  L.push('');
  L.push('## 怎么用');
  L.push('');
  L.push('**优先级（后者覆盖前者）：**');
  L.push('');
  L.push('```');
  L.push('schema 默认值  <  scripts/config.json  <  scripts/config.local.json  <  环境变量');
  L.push('```');
  L.push('');
  L.push('- `scripts/config.json` —— 团队共享配置（入库）');
  L.push('- `scripts/config.local.json` —— 个人覆盖（**不入库**，深合并进去）');
  L.push('- 环境变量 —— `TAPTAP_CFG_<分组>_<字段>`，分组与字段转大写、点换下划线。');
  L.push('  例：`TAPTAP_CFG_REPLY_MAXCHARS_POST=200`、`TAPTAP_CFG_EXEC_WORKERPOOL_ENABLED=true`');
  L.push('');
  L.push('**每个功能只有一个 `enabled`**，放在该功能自己的分组下。旧键（`features.*` / `plugins.*`）启动时会自动迁移：');
  L.push('新键写入，**旧键暂时保留兼容**（等所有消费方改造完才删）。迁移清单会打一行日志，不静默。');
  L.push('');
  L.push('**校验失败不阻断运行** —— 配置项写错只打警告，守护不会因此停摆。');
  L.push('');
  L.push(`## 字段总览（共 ${fields.length} 项）`);
  L.push('');
  L.push('| 分组 | 键 | 类型 | 默认 | 范围 | 说明 |');
  L.push('|---|---|---|---|---|---|');
  for (const { path, def, groupLabel } of fields) {
    const desc = (def.description || def.label || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    L.push(`| ${groupLabel} | \`${path}\` | ${typeLabel(def)} | ${defaultLabel(def)} | ${rangeLabel(def)} | ${desc} |`);
  }
  L.push('');
  L.push('## 分组说明');
  L.push('');
  for (const [gid, g] of Object.entries(schema.groups || {})) {
    L.push(`### ${g.label || gid}${gid === 'root' ? '（顶层字段）' : ` · \`${gid}\``}`);
    L.push('');
    if (g.description) L.push(g.description);
    L.push('');
    for (const [k, def] of Object.entries(g.fields || {})) {
      const path = gid === 'root' ? k : `${gid}.${k}`;
      L.push(`- **\`${path}\`** — ${def.label || ''}`);
      if (def.description) L.push(`  ${def.description}`);
      L.push(`  默认 \`${JSON.stringify(def.default)}\`${def.enum ? `，取值 ${def.enum.join(' / ')}` : ''}`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  L.push('');
  return L.join('\n');
}

const md = render();

if (has('check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // 忽略时间戳行再比较
  const norm = (s) => s.replace(/生成时间：.*/g, '').trim();
  if (norm(cur) === norm(md)) {
    console.log(`  ✓ docs 已是最新（${OUT}）`);
    process.exit(0);
  }
  console.error(`  ✗ 文档已过期，请重跑：node scripts/config-doc.mjs`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md, 'utf8');
console.log(`  ✓ 已生成 ${OUT}（${listFields(schema).length} 项字段）`);

// 顺带体检：config.json 里有没有 schema 没定义的键（新加参数忘了写 schema）
try {
  const cfg = JSON.parse(readFileSync(resolve(SKILL_ROOT, 'scripts', 'config.json'), 'utf8'));
  const extras = diffExtraKeys(cfg, schema);
  if (extras.length) {
    console.log(`  ${extras.length} 个键未在 schema 中定义（建议补上，否则文档查不到）：`);
    for (const p of extras.slice(0, 30)) console.log(`    · ${p}`);
    if (extras.length > 30) console.log(`    … 还有 ${extras.length - 30} 个`);
  } else {
    console.log('  ✓ config.json 所有键都有 schema 定义');
  }
} catch (e) {
  console.log(`  （跳过 config.json 体检：${e.message}）`);
}