#!/usr/bin/env node
// 答疑库归档回归测试（30 天未引用 → 冷数据）
//
// 改 scripts/lib/archive.mjs 或 usage.mjs 的 shouldArchive 前后各跑一次：
//   node scripts/test-archive.mjs

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveStale, isStale, renderEntry } from './lib/archive.mjs';
import { shouldArchive } from './lib/usage.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const DAY = 86400000;
const now = new Date('2026-10-26T18:00:00+08:00');
const daysAgo = (n) => new Date(now.getTime() - n * DAY).toISOString();

console.log('== isStale：30 天未引用 ==');
check('40 天前引用过 → 应归档', isStale({ cited: 5, lastCitedAt: daysAgo(40) }, { staleDays: 30, now: now.getTime() }) === true);
check('3 天前引用过 → 保留', isStale({ cited: 2, lastCitedAt: daysAgo(3) }, { staleDays: 30, now: now.getTime() }) === false);
check('从没引用过（35 天前入库）→ 应归档', isStale({ cited: 0, lastCitedAt: null, createdAt: daysAgo(35) }, { staleDays: 30, now: now.getTime() }) === true);
check('刚入库没引用 → 保留', isStale({ cited: 0, lastCitedAt: null, createdAt: daysAgo(2) }, { staleDays: 30, now: now.getTime() }) === false);

console.log('\n== shouldArchive：每月 1~5 号 ==');
check('10-01 触发', shouldArchive({ lastArchiveAt: null }, new Date('2026-10-01T10:00:00')) === true);
check('10-03 触发', shouldArchive({ lastArchiveAt: null }, new Date('2026-10-03T10:00:00')) === true);
check('10-05 触发', shouldArchive({ lastArchiveAt: null }, new Date('2026-10-05T10:00:00')) === true);
check('10-06 不触发', shouldArchive({ lastArchiveAt: null }, new Date('2026-10-06T10:00:00')) === false);
check('10-15 不触发', shouldArchive({ lastArchiveAt: null }, new Date('2026-10-15T10:00:00')) === false);
check(
  '本月已整理过 → 不再触发',
  shouldArchive({ lastArchiveAt: '2026-10-03T10:00:00' }, new Date('2026-10-05T10:00:00')) === false
);

console.log('\n== 执行归档 ==');
const tmp = await mkdtemp(join(tmpdir(), 'pvz2-archive-test-'));
try {
  await mkdir(join(tmp, '归档'), { recursive: true });
  const entries = [
    { id: 'old-one', question: '很久没用的老问题', keywords: ['老', '问题'], version: '通用', answer: '老答案', auto: false },
    { id: 'fresh-one', question: '最近常用的新问题', keywords: ['新', '问题'], version: '通用', answer: '新答案', auto: false },
    { id: 'never-cited', question: '从没被引用的条目', keywords: ['没', '引用'], version: '通用', answer: '某答案', auto: true, source: 'https://x/y' },
  ];
  const qaFile = join(tmp, '答疑库.md');
  await writeFile(qaFile, '# 测试答疑库\n\n' + entries.map(renderEntry).join('\n'), 'utf8');

  const usage = {
    items: {
      'old-one': { cited: 5, lastCitedAt: daysAgo(40), createdAt: daysAgo(60), archived: false },
      'fresh-one': { cited: 2, lastCitedAt: daysAgo(3), createdAt: daysAgo(50), archived: false },
      'never-cited': { cited: 0, lastCitedAt: null, createdAt: daysAgo(35), archived: false },
    },
    lastArchiveAt: null,
  };

  const res = await archiveStale({
    qaFile,
    archiveDir: join(tmp, '归档'),
    entries,
    usage,
    staleDays: 30,
    now,
  });

  check('归档了 2 条', res.archived.length === 2, JSON.stringify(res.archived));
  check('保留了 1 条', res.kept.length === 1, JSON.stringify(res.kept));
  check('冷数据文件已生成', !!res.coldFile && res.coldFile.includes('冷数据'));

  const main = await readFile(qaFile, 'utf8');
  check('主库只剩保留的那条', main.includes('最近常用的新问题') && !main.includes('很久没用的老问题'));
  check('主库表头记录了整理信息', /归档\s*2/.test(main), main.slice(0, 120));

  const cold = await readFile(res.coldFile, 'utf8');
  check('冷数据含被归档的条目', cold.includes('很久没用的老问题'));
  check('冷数据保留原文（只移动不删除）', cold.includes('老答案'));
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
