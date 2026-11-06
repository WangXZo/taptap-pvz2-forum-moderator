#!/usr/bin/env node
// 「已移除的加好友帖清单」工具回归测试
//
// 盯三件事：
//   1) 时间参数解析（多种写法）+ 区间过滤是闭区间
//   2) 好友码提取不吃普通英文词、且忽略大小写去重
//   3) 这套工具是**固定脚本**：入口固定、参数固定 → 以后只传参，不另写脚本

import {
  parseTime,
  filterByTimeWindow,
  stampOf,
  extractCodes,
  dedupeCodes,
} from './removed-list.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else fails.push(`${name}\n    期望 ${b}\n    实际 ${a}`);
};

// ---------- 1. 时间解析 ----------
ok('解析 "YYYY-MM-DD HH:mm:ss"', parseTime('2026-10-30 13:22:11') !== null);
ok('解析 "YYYY/MM/DD HH:mm:ss"', parseTime('2026/10/30 13:22:11') !== null);
ok('解析 ISO', parseTime('2026-10-30T13:22:11') !== null);
ok('解析失败返回 null', parseTime('不是时间') === null);
ok('空值返回 null', parseTime('') === null);
eq(
  '斜杠写法与横杠写法等价',
  parseTime('2026/10/30 13:22:11'),
  parseTime('2026-10-30 13:22:11')
);

// ---------- 2. 区间过滤（闭区间）----------
const T = (s) => new Date(s).toISOString();
const posts = [
  { id: 'a', removedAt: T('2026-10-30T12:00:00') },
  { id: 'b', removedAt: T('2026-10-30T13:22:11') },
  { id: 'c', removedAt: T('2026-10-31T09:00:00') },
  { id: 'd', removedAt: T('2026-11-02T08:00:00') },
  { id: 'e', removedAt: null },
];
const from = parseTime('2026-10-30 13:22:11');
const to = parseTime('2026-11-02 08:00:00');
eq('区间过滤命中（含端点）', filterByTimeWindow(posts, { from, to }).map((p) => p.id), ['b', 'c', 'd']);
eq('只有下界', filterByTimeWindow(posts, { from }).map((p) => p.id), ['b', 'c', 'd']);
eq('只有上界', filterByTimeWindow(posts, { to }).map((p) => p.id), ['a', 'b', 'c', 'd']);
eq('没有时间窗 → 全给', filterByTimeWindow(posts, {}).length, posts.length);
ok('没有 removedAt 的被剔除', !filterByTimeWindow(posts, { from }).some((p) => p.id === 'e'));

// ---------- 3. 好友码提取 ----------
ok('认出 and 码', extractCodes('andABCDEFGH').includes('andABCDEFGH'));
ok('认出 ios 码', extractCodes('iosABCDEFGH').includes('iosABCDEFGH'));
ok('不吃普通小写英文词', extractCodes('taptap android moment').length === 0);
ok('有数字的裸码能认', extractCodes('ABCDEFGH').length === 1, JSON.stringify(extractCodes('ABCDEFGH')));
eq('多个码一次取全', extractCodes('加好友 andABC123 和 iosXYZ789').length, 2);

// ---------- 4. 去重（忽略大小写）----------
const u = dedupeCodes(['andABC123', 'andabc123', 'andABC123', 'iosZZZ999']);
eq('去重后剩 2 个', u.length, 2);
eq('保留出现次数多的写法', u.find((x) => x.key === 'andabc123')?.code, 'andABC123');
eq('出现次数统计正确', u.find((x) => x.key === 'andabc123')?.count, 3);

// ---------- 5. 文件名 ----------
ok('stampOf 是 ASCII 紧凑串', /^\d{8}-\d{4}$/.test(stampOf(parseTime('2026-10-30 13:22:11'))), stampOf(parseTime('2026-10-30 13:22:11')));

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
