// 耗时打点测试（2026-11-20 · T20）
import { begin, since, summarizePerf, renderPerf, PHASES } from './lib/perf.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

console.log('\n== begin / since ==');
{
  const t0 = begin();
  await new Promise((r) => setTimeout(r, 30));
  const ms = since(t0);
  t('返回整数毫秒', Number.isInteger(ms));
  t('至少 25ms', ms >= 25, `实际 ${ms}`);
  t('since(null) → null', since(null) === null);
  t('since(undefined) → null', since(undefined) === null);
}
{
  const t0 = begin();
  const a = since(t0);
  const b = since(t0);
  t('同一 t0 可重复读取', Number.isInteger(a) && Number.isInteger(b) && b >= a);
}

console.log('\n== summarizePerf ==');
{
  const rows = [
    { event: 'phase', phase: 'compose', ms: 1000 },
    { event: 'phase', phase: 'compose', ms: 2000 },
    { event: 'phase', phase: 'compose', ms: 3000 },
    { event: 'phase', phase: 'send', ms: 200 },
    { event: 'phase', phase: 'send', ms: 400 },
    { event: 'sent', sent: true },              // 非 phase，应忽略
    { event: 'phase', phase: 'compose' },       // 无 ms，应忽略
    { event: 'phase', ms: 5 },                  // 无 phase，应忽略
    null,
  ];
  const s = summarizePerf(rows);
  t('compose 计数 3', s.byPhase.compose.count === 3, JSON.stringify(s.byPhase.compose));
  t('compose 平均 2000', s.byPhase.compose.avg === 2000);
  t('compose p50 = 2000', s.byPhase.compose.p50 === 2000);
  t('compose p90 = 3000', s.byPhase.compose.p90 === 3000);
  t('compose max = 3000', s.byPhase.compose.max === 3000);
  t('send 计数 2', s.byPhase.send.count === 2);
  t('send 平均 300', s.byPhase.send.avg === 300);
  t('样本总数 5（忽略非 phase）', s.samples === 5, `实际 ${s.samples}`);
  t('总耗时 6600', s.totalMs === 6600, `实际 ${s.totalMs}`);
  t('每帖耗时 = 总/compose次数', s.perPostMs === 2200, `实际 ${s.perPostMs}`);
}
{
  const s = summarizePerf([]);
  t('空数据不炸', s.samples === 0 && Object.keys(s.byPhase).length === 0);
  t('空数据 perPostMs = null', s.perPostMs === null);
}

console.log('\n== renderPerf ==');
{
  const s = summarizePerf([
    { event: 'phase', phase: 'compose', ms: 5000 },
    { event: 'phase', phase: 'send', ms: 1000 },
    { event: 'phase', phase: 'fetch_comments', ms: 4000 },
  ]);
  const md = renderPerf(s, { date: '2026-11-20' });
  t('有标题', md.includes('# 耗时分布 2026-11-20'));
  t('有表格', md.includes('| 阶段 | 次数 |'));
  t('列出 compose', md.includes('compose'));
  t('列出 send', md.includes('| send |'));
  t('指出瓶颈', md.includes('**瓶颈：'), md.split('\n').slice(-4).join(' / '));
  // 占比：compose 5000 / 10000 = 50%，fetch_comments 40%，send 10%
  t('占比正确（compose 50%）', md.includes('| 50%'), md);
  t('瓶颈是 compose', /\*\*瓶颈：`compose`\*\*/.test(md), md.split('\n').filter((l) => l.includes('瓶颈')).join(''));
}
{
  const md = renderPerf(summarizePerf([]), { date: '2026-11-20' });
  t('空数据给出解释', md.includes('没有 phase 打点记录'));
  t('空数据不吐表格', !md.includes('| 阶段 |'));
}

console.log('\n== PHASES 常量 ==');
t('有 compose', PHASES.compose === 'compose');
t('有 send', PHASES.send === 'send');
t('有 fetch_comments', PHASES.fetchComments === 'fetch_comments');

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);