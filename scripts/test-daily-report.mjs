// B1.5 日报离线测试：renderDaily 纯函数 + summarizeTrace 串联。
import { renderDaily } from './lib/daily-report.mjs';
import { summarizeTrace } from './lib/trace.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const rows = [
  { ts: '2026-11-18T01:00:00.000Z', event: 'verdict', postId: 'p1', title: '困难6怎么过', intent: 'qa', source: 'qa', tier: 'high', score: 0.86 },
  { ts: '2026-11-18T01:00:05.000Z', event: 'gen', postId: 'p1', genMs: 1200, faithOk: true, channelsTried: 3 },
  { ts: '2026-11-18T01:00:06.000Z', event: 'sent', postId: 'p1', sent: true, kind: 'answer' },
  { ts: '2026-11-18T01:01:00.000Z', event: 'verdict', postId: 'p2', title: '求安卓天宫码', intent: 'code', tier: 'abstain', reason: 'abstain_low_conf' },
  { ts: '2026-11-18T01:02:00.000Z', event: 'verdict', postId: 'p3', title: '抽到瓷砖萝卜', intent: 'celebrate', source: 'qa', tier: 'mid' },
  { ts: '2026-11-18T01:02:10.000Z', event: 'gen', postId: 'p3', genMs: 1800, faithOk: false, reason: 'faithfulness_fail' },
];

console.log('\n== summarizeTrace → renderDaily ==');
const sum = summarizeTrace(rows);
const md = renderDaily({ summary: sum, rows, date: '2026-11-18', config: { pipeline: 'v2', retrieve: { denseBackend: 'bge' }, rerank: { backend: 'onnx' } } });
t('标题含日期', md.includes('# 答疑日报 2026-11-18'));
t('指标：trace 条数', md.includes('| trace 条数 | 6 |'));
t('指标：已发送 1', md.includes('| 已发送 | 1 |'));
t('指标：弃答 1', md.includes('| 弃答（abstain/低置信） | 1 |'));
t('指标：忠实度失败 1', md.includes('| 忠实度失败（转人工） | 1 |'));
t('指标：平均生成耗时 (1200+1800)/2=1500', md.includes('1500 ms'));
t('意图分布表', md.includes('## 按意图') && md.includes('| qa | 1 |'));
t('分档分布表', md.includes('## 按分档') && md.includes('| high | 1 |'));
t('值得注意：忠实度失败', md.includes('忠实度自检不通过'));
t('值得注意：弃答', md.includes('分档弃答'));
t('单帖多事件聚合', md.includes('## 单帖多事件') && md.includes('verdict → gen → sent'));
t('环境信息带 pipeline/rerank', md.includes('pipeline=v2') && md.includes('rerank=onnx'));

console.log('\n== 空 trace ==');
const md0 = renderDaily({ summary: summarizeTrace([]), rows: [], date: '2026-11-19' });
t('空数据不崩', md0.includes('# 答疑日报 2026-11-19'));
t('空数据有提示', md0.includes('今日无 trace 记录'));

console.log('\n== 无 reason/tier 时不产生噪声 ==');
const md1 = renderDaily({ summary: summarizeTrace([{ event: 'sent', postId: 'x', sent: true }]), rows: [{ event: 'sent', postId: 'x', sent: true }], date: '2026-11-20' });
t('无值得注意段', !md1.includes('## 值得注意'));
t('单事件不列多事件', !md1.includes('## 单帖多事件'));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);