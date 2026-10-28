#!/usr/bin/env node
// 答疑库还原：从备份恢复（每轮自动备份的 qa/答疑库.backup.md）
//
// 用法：
//   node scripts/restore-qa.mjs            # 看备份状态
//   node scripts/restore-qa.mjs --restore  # 用备份覆盖当前库
//
// 背景：曾用构建源里的旧副本覆盖运行中的答疑库，一夜之间沉淀的 10 条问答全丢。
//       有了每轮备份 + 这个脚本，最坏情况一条命令就能回退。

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { loadConfig } from './lib/paths.mjs';

const config = await loadConfig();
const cur = config.paths.qaFile;
const bak = `${cur}.backup.md`;
const restore = process.argv.includes('--restore');

const count = (f) => {
  try {
    return (readFileSync(f, 'utf8').match(/^## 问/gm) || []).length;
  } catch {
    return 0;
  }
};

console.log(`当前库   ：${cur}`);
console.log(`  条数 ${existsSync(cur) ? count(cur) : 0}`);
console.log(`备份     ：${bak}`);
console.log(`  条数 ${existsSync(bak) ? count(bak) : 0}${existsSync(bak) ? `（${new Date(statSync(bak).mtime).toLocaleString('zh-CN')}）` : ''}`);

if (!restore) {
  console.log('\n要还原就加 --restore');
  process.exit(0);
}

if (!existsSync(bak)) {
  console.error('\n没有备份文件，无法还原');
  process.exit(1);
}

writeFileSync(cur, readFileSync(bak, 'utf8'), 'utf8');
console.log(`\n已用备份还原：${cur}（${count(cur)} 条）`);
