// O3 QA 治理离线测试（2026-11-18）：分层 junk + 近重复合并 + 数字否决 + 报告 + apply 归档。
import { scanJunkLayered } from './lib/qa-junk.mjs';
import { findNearDuplicates, mergeInto, normQuestion, keyNumbers, numbersConflict } from './lib/qa-dedup.mjs';
import { governQa, parseQaEntries, renderGovernReport } from './lib/qa-govern.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const LIB = `# 答疑库

> 说明

## 问：困难6怎么过
- 关键词：困难6
---
用冰车加机枪。

## 问：困难8怎么过
- 关键词：困难8
---
换成玉米加农炮。

## 问：加好友一起赚宝箱
- 关键词：加好友
---
加我吧。

## 问：大佬们快加我
- 关键词：好友
---
iosABCDEFGH。

## 问：如题
- 关键词：无
---
不知道。

## 问：如题
- 关键词：无
---
同上。

## 问：688是单抽还是十连
- 关键词：688
---
十连。

## 问：688钻石宝箱是单抽还是十连
- 关键词：688
---
十连抽。
`;

console.log('\n== 分层 junk（junk 不看 cited / noise 看 cited）==');
{
  const r = scanJunkLayered(LIB, { citedOf: () => 0 });
  const junk = r.hits.filter((h) => h.layer === 'junk').map((h) => h.question);
  t('求码/加好友类命中 junk 层', junk.some((q) => q.includes('加好友')));
  t('「大佬们快加我」漏网已补（真实数据发现）', junk.includes('大佬们快加我'));
  t('纯噪声标题（如题）进 noise 层', r.hits.some((h) => h.layer === 'noise' && h.question === '如题'));
  const r2 = scanJunkLayered(LIB, { citedOf: (q) => (q === '如题' ? 3 : 0) });
  t('noise 层 cited>0 → 豁免不剔', !r2.hits.some((h) => h.layer === 'noise'));
  t('豁免计数', r2.exempted >= 1);
  const r3 = scanJunkLayered(LIB, { citedOf: () => 5 });
  t('junk 层 cited 再高也剔', r3.hits.some((h) => h.layer === 'junk'));
}

console.log('\n== 数字否决（困难6 vs 困难8 不能合并）==');
{
  t('抽数字', keyNumbers('困难6怎么过').has('6'));
  t('数字不同 → 冲突', numbersConflict(keyNumbers('困难6怎么过'), keyNumbers('困难8怎么过')) === true);
  t('有共同数字 → 不冲突', numbersConflict(keyNumbers('688是单抽吗'), keyNumbers('688宝箱')) === false);
  const entries = parseQaEntries(LIB);
  const { groups } = findNearDuplicates(entries.filter((e) => /困难/.test(e.question)), { threshold: 0.9 });
  t('困难6/困难8 不被合并', groups.length === 0);
}

console.log('\n== 近重复合并 ==');
{
  const es = [
    { id: 'a', question: '688是单抽还是十连', keywords: ['688'], answer: '十连' },
    { id: 'b', question: '688钻石宝箱是单抽还是十连', keywords: ['宝箱'], answer: '十连抽' },
    { id: 'c', question: '完全无关的另一件事', keywords: [], answer: 'x' },
  ];
  const { groups } = findNearDuplicates(es, { threshold: 0.9 });
  t('同义两条成组', groups.length === 1 && groups[0].drop.length === 1);
  const m = mergeInto(groups[0].keep, groups[0].drop);
  t('合并后含同义问法', m.answer.includes('同义问法'));
  t('关键词合并去重', m.keywords.includes('688') && m.keywords.includes('宝箱'));
  const es2 = [
    { id: 'x', question: '完全相同的问题', answer: 'a' },
    { id: 'y', question: '完全相同的问题', answer: 'b' },
  ];
  const r2 = findNearDuplicates(es2, { threshold: 0.99 });
  t('归一化后完全同文 → 必合并', r2.groups.length === 1);
  // 阈值生效：明显不同说法不该被合并
  const es3 = [
    { id: 'p', question: '688怎么抽', answer: 'a' },
    { id: 'q', question: '瓷砖萝卜稀有吗', answer: 'b' },
  ];
  t('不同主题不合并', findNearDuplicates(es3, { threshold: 0.9 }).groups.length === 0);
  // 回归（dry-run 实测）：极短标题（泛实体）不能作为合并主体
  const es4 = [
    { id: 'e1', question: '无尽', answer: '无尽玩法说明' },
    { id: 'e2', question: '摇滚无尽', answer: '摇滚模式的无尽' },
  ];
  t('极短标题不合并（无尽 vs 摇滚无尽）', findNearDuplicates(es4, { threshold: 0.9 }).groups.length === 0);
}

console.log('\n== governQa dry-run / apply ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'qagov-'));
  const qaFile = join(dir, '答疑库.md');
  writeFileSync(qaFile, LIB, 'utf8');
  const archiveDir = join(dir, '归档');
  const usage = { items: {} };
  // dry-run
  const dry = await governQa({ qaFile, archiveDir, usage, config: {}, apply: false });
  t('dry-run 识别剔除与合并', dry.junk.length >= 3 && dry.groups.length >= 1);
  t('dry-run 未改库', readFileSync(qaFile, 'utf8') === LIB);
  t('dry-run 无归档文件', !existsSync(archiveDir));
  t('报告标 dry-run', dry.report.includes('dry-run'));
  // apply
  const res = await governQa({ qaFile, archiveDir, usage, config: {}, apply: true });
  t('apply 后库变小', res.after < res.before);
  const after = readFileSync(qaFile, 'utf8');
  t('junk 条目已移除', !after.includes('大佬们快加我') && !after.includes('加好友一起赚宝箱'));
  t('困难6/困难8 都保留（否决闸）', after.includes('困难6怎么过') && after.includes('困难8怎么过'));
  t('合并后保留同义问法', after.includes('同义问法'));
  t('归档文件已生成', existsSync(res.archivedFiles.junk) && existsSync(res.archivedFiles.merged));
  t('有备份', existsSync(res.archivedFiles.backup));
  t('归档内容含被剔条目（可恢复）', readFileSync(res.archivedFiles.junk, 'utf8').includes('大佬们快加我'));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n== 回归：治理重写不丢语义确认标记（2026-11-19 审查发现）==');
{
  const LIB2 = `# 答疑库

## 问：花盆挂件碎片自选会过期吗
- 关键词：花盆挂件
- 语义确认：true
---
有时限，过期消不掉。
`;
  const dir = mkdtempSync(join(tmpdir(), 'qagov2-'));
  const qaFile = join(dir, '答疑库.md');
  writeFileSync(qaFile, LIB2, 'utf8');
  // 造一条 junk 触发重写
  writeFileSync(qaFile, LIB2 + '\n## 问：加好友一起玩\n- 关键词：加好友\n---\n加我吧。\n', 'utf8');
  await governQa({ qaFile, archiveDir: join(dir, '归档'), usage: { items: {} }, config: {}, apply: true });
  const after = readFileSync(qaFile, 'utf8');
  t('重写后「语义确认：true」保留', after.includes('- 语义确认：true'));
  t('junk 已剔除', !after.includes('加好友一起玩'));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n== 报告渲染 ==');
{
  const md = renderGovernReport({ scanned: { hits: [{ question: 'q1', layer: 'junk', pattern: 'p' }], exempted: 2 }, groups: [{ keep: { question: 'k' }, drop: [{ question: 'd' }], similarity: 0.97 }], before: 10, after: 8, now: new Date('2026-11-18'), apply: true });
  t('含已应用标记', md.includes('**已应用**'));
  t('含条数变化', md.includes('10 → 8'));
  t('含 junk 列表', md.includes('q1'));
  t('含合并列表', md.includes('相似度 0.97'));
  t('干净库提示', renderGovernReport({ scanned: { hits: [] }, groups: [] }).includes('库干净'));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);