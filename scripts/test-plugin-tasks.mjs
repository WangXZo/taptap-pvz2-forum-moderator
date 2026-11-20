// P4-c 测试（2026-11-19）：weekly 周报 + comment 评论分析 + review 只读分析
import weeklyPlugin, { shouldRunWeeklyReport } from './plugins/weekly.mjs';
import commentPlugin from './plugins/comment.mjs';
import reviewPlugin, { analyzeReviews, renderReviewReport } from './plugins/review.mjs';
import { renderWeekly } from './lib/weekly-report.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== weekly: shouldRunWeeklyReport ==');
{
  const now = new Date('2026-11-20T12:00:00Z');
  t('从未跑过 → 该跑', shouldRunWeeklyReport({}, { now }) === true);
  t('刚跑过 → 不跑', shouldRunWeeklyReport({ lastWeeklyAt: '2026-11-20T09:00:00Z' }, { now }) === false);
  t('8 天前 → 跑', shouldRunWeeklyReport({ lastWeeklyAt: '2026-11-12T12:00:00Z' }, { now }) === true);
  t('weekly=false → 不跑', shouldRunWeeklyReport({ weekly: false }, { now }) === false);
}

console.log('\n== weekly: renderWeekly（纯函数）==');
{
  const daily = [
    { date: '2026-11-18', summary: { total: 5, sent: 3, abstain: 1, faithFail: 0, channelFail: 2, avgGenMs: 1200, byIntent: { qa: 3, share: 2 }, byTier: { high: 2 } } },
    { date: '2026-11-19', summary: { total: 4, sent: 2, abstain: 1, faithFail: 1, channelFail: 1, avgGenMs: 1500, byIntent: { qa: 4 }, byTier: { mid: 3 } } },
  ];
  const md = renderWeekly({ from: '2026-11-18', to: '2026-11-19', daily, usage: { items: { '困难6': { cited: 5 } } }, config: { pipeline: 'v2' }, libStats: { qaBefore: 140, qaAfter: 145, facts: 10 } });
  t('标题带区间', md.includes('答疑周报 2026-11-18 ~ 2026-11-19'));
  t('总览合计', md.includes('| trace 事件 | 9 |') && md.includes('| 已发送 | 5 |'));
  t('弃答合计 2', md.includes('| 弃答（abstain/低置信） | 2 |'));
  t('忠实失败合计 1', md.includes('| 忠实度失败 | 1 |'));
  t('每日趋势表', md.includes('## 每日趋势') && md.includes('| 2026-11-18 | 5 |'));
  t('意图分布', md.includes('## 意图分布') && md.includes('| qa | 7 |'));
  t('分档分布', md.includes('## 分档分布'));
  t('知识库变化', md.includes('140 → 145') && md.includes('facts：10'));
  t('被引用最多', md.includes('## 被引用最多的知识') && md.includes('困难6'));
  t('值得注意段', md.includes('## 值得注意'));
  t('空数据提示', renderWeekly({ daily: [], rows: [] }).includes('本期无 trace 数据'));
}

console.log('\n== weekly: build（真实 trace 文件）==');
{
  const dir = mkdtempSync(join(tmpdir(), 'wk-'));
  const reports = join(dir, 'reports');
  mkdirSync(reports, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  writeFileSync(join(reports, `trace-${ymd}.jsonl`),
    [JSON.stringify({ ts: new Date().toISOString(), event: 'sent', postId: 'p1', sent: true, kind: 'answer' }),
     JSON.stringify({ ts: new Date().toISOString(), event: 'verdict', postId: 'p2', intent: 'qa', tier: 'high' })].join('\n') + '\n');
  const config = { paths: { reportsDir: reports, qaFile: join(dir, 'qa.md'), postDbFile: join(dir, 'rec.sqlite') }, weekly: { enabled: true } };
  const r = await weeklyPlugin.build({ config, log: () => {}, usage: {}, days: 7, now: d });
  t('生成了报告文件', Boolean(r.out) && existsSync(r.out));
  t('统计到 1 条发送', r.sent === 1);
  t('文件名含区间', /周报-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$/.test(r.out));
  // scheduled：未到周期 / 关闭
  const s1 = await weeklyPlugin.scheduled({ config, log: () => {}, usage: { lastWeeklyAt: new Date().toISOString() } });
  t('未到周期 → skipped not_due', s1.skipped === 'not_due');
  const s2 = await weeklyPlugin.scheduled({ config: { ...config, weekly: { enabled: false } }, log: () => {} });
  t('关闭 → skipped disabled', s2.skipped === 'disabled');
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n== comment: 规则识别反对/补充 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'cm-'));
  const config = { paths: { dataDir: join(dir, 'data') }, comment: { enabled: true } };
  const mkC = (text, id = 'c1') => ({ id_str: id, author: { name: '玩家' }, contents: { json: [{ children: [{ text }] }] }, child_posts: [] });
  const results = [
    { id: 'p1', _comments: [mkC('你说得不对，早就改了', 'c1'), mkC('补充一下，还有紫色手套也行', 'c2'), mkC('谢谢分享', 'c3')] },
    { id: 'p2', _comments: [mkC('这个过时了吧', 'c4')] },
  ];
  const r = await commentPlugin.planBatch(results, { config, log: () => {} });
  t('只分析不发送（返回 null）', r === null);
  const f = join(dir, 'data', 'comment-analysis.jsonl');
  t('分析文件已生成', existsSync(f));
  const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  t('识别出 3 条信号（2 反对 + 1 补充）', rows.length === 3);
  t('含 oppose 类型', rows.some((x) => x.kind === 'oppose'));
  t('含 supplement 类型', rows.some((x) => x.kind === 'supplement'));
  t('无关评论未记录', !rows.some((x) => x.text.includes('谢谢分享')));
  // 去重：同批再跑不重复写
  await commentPlugin.planBatch(results, { config, log: () => {} });
  const rows2 = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  t('同 postId+commentId 去重', rows2.length === 3);
  // 关闭时不动作
  const r2 = await commentPlugin.planBatch(results, { config: { ...config, comment: { enabled: false } }, log: () => {} });
  t('关闭 → null', r2 === null);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n== review: 只读分析（不回复）==');
{
  t('无 planBatch（永不发送）', typeof reviewPlugin.planBatch === 'undefined');
  const analyzed = analyzeReviews([
    { score: 1, text: '老是闪退，根本玩不了' },
    { score: 2, text: '太氪了抽不到植物' },
    { score: 5, text: '很好玩' },
    { score: 1, text: '客服不理人' },
  ], { lowScoreMax: 2 });
  t('低分只统计 ≤2 星', analyzed.lowCount === 3);
  t('按关键词归类', analyzed.byTag['闪退/崩溃'] === 1 && analyzed.byTag['收费/逼氪'] === 1 && analyzed.byTag['客服/申述'] === 1);
  const md = renderReviewReport({ analyzed, date: '2026-11-20', config: {} });
  t('报告声明不自动回复', md.includes('不自动回复评价'));
  t('报告含归因表', md.includes('差评归因') && md.includes('闪退/崩溃'));
  // scheduled：默认关闭 → skip
  const s1 = await reviewPlugin.scheduled({ config: {}, log: () => {} });
  t('默认关闭 → skipped disabled', s1.skipped === 'disabled');
  // 开启但无 fetcher → skip（不擅自调接口）
  const s2 = await reviewPlugin.scheduled({ config: { review: { enabled: true } }, log: () => {} });
  t('无 fetcher → skipped no_fetcher', s2.skipped === 'no_fetcher');
  // 注入 fetcher → 生成报告
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  const s3 = await reviewPlugin.scheduled({
    config: { review: { enabled: true }, paths: { reportsDir: join(dir, 'reports') } },
    log: () => {},
    fetchReviews: async () => [{ score: 1, text: '闪退严重' }],
  });
  t('注入 fetcher → 生成报告', s3.ok === true && existsSync(s3.out));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);