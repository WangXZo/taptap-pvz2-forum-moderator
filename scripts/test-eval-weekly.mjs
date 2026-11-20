// P4-d 周度评测调度测试（2026-11-19）：shouldRunWeekly 纯函数
import { shouldRunWeekly } from './lib/eval.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const now = new Date('2026-11-19T12:00:00Z');

console.log('\n== shouldRunWeekly ==');
{
  t('从未跑过 → 该跑', shouldRunWeekly({}, { now }) === true);
  t('刚跑过 → 不跑', shouldRunWeekly({ lastEvalAt: '2026-11-19T10:00:00Z' }, { now }) === false);
  t('6 天前跑过 → 不跑（默认 7 天）', shouldRunWeekly({ lastEvalAt: '2026-11-13T12:00:00Z' }, { now }) === false);
  t('7 天整 → 跑', shouldRunWeekly({ lastEvalAt: '2026-11-12T12:00:00Z' }, { now }) === true);
  t('8 天前 → 跑', shouldRunWeekly({ lastEvalAt: '2026-11-11T12:00:00Z' }, { now }) === true);
  t('自定义 everyDays=1：12 小时内跑过 → 不跑', shouldRunWeekly({ lastEvalAt: '2026-11-19T00:00:00Z' }, { now, everyDays: 1 }) === false);
  t('自定义 everyDays=1：正好 1 天 → 跑', shouldRunWeekly({ lastEvalAt: '2026-11-18T12:00:00Z' }, { now, everyDays: 1 }) === true);
  t('evalWeekly=false → 永不跑', shouldRunWeekly({ evalWeekly: false }, { now }) === false);
  t('时间戳损坏 → 当作没跑过', shouldRunWeekly({ lastEvalAt: 'bad-date' }, { now }) === true);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);