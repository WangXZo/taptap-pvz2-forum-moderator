// O2 结构化 trace 离线测试（2026-11-18 B1）
import { trace, traceFile, readTrace, pruneTrace, summarizeTrace } from './lib/trace.mjs';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
const config = { paths: { reportsDir: dir }, trace: { enabled: true, keepDays: 14 } };

console.log('\n== trace 写入 ==');
const f = trace({ config, event: 'verdict', postId: 'p1', title: '  困难6   怎么过  ', intent: 'qa', source: 'qa', entryId: 'q1', score: 0.856, tier: 'high', judgeOk: true, reason: null });
t('返回文件路径', Boolean(f) && f.endsWith('.jsonl'));
const rows = readTrace(config);
t('写入 1 行', rows.length === 1);
t('标题压空白且截断', rows[0].title === '困难6 怎么过');
t('分数保留 3 位', rows[0].score === 0.856);
t('null 字段不写', !('reason' in rows[0]));
t('ts 是 ISO', /^\d{4}-\d{2}-\d{2}T/.test(rows[0].ts));
t('postId 保留', rows[0].postId === 'p1');

console.log('\n== append 而非重写 ==');
trace({ config, event: 'gen', postId: 'p1', genMs: 1234, faithOk: true });
trace({ config, event: 'sent', postId: 'p1', sent: true, kind: 'answer' });
t('累计 3 行', readTrace(config).length === 3);

console.log('\n== 关闭开关不写 ==');
const n0 = readTrace(config).length;
trace({ config: { ...config, trace: { enabled: false } }, event: 'gen', postId: 'p2' });
t('enabled=false → 不写', readTrace(config).length === n0);
t('返回 null', trace({ config: { ...config, trace: { enabled: false } }, event: 'x' }) === null);

console.log('\n== summarizeTrace ==');
const sum = summarizeTrace(readTrace(config));
t('统计条数', sum.total === 3);
t('按事件分组', sum.byEvent.verdict === 1 && sum.byEvent.gen === 1 && sum.byEvent.sent === 1);
t('已发送计数', sum.sent === 1);
t('平均生成耗时', sum.avgGenMs === 1234);
t('按意图分组', sum.byIntent.qa === 1);
t('按分档分组', sum.byTier.high === 1);

console.log('\n== pruneTrace 裁剪 ==');
const today = new Date();
const old = new Date(today.getTime() - 30 * 86400000);
const p = (n) => String(n).padStart(2, '0');
const oldName = `trace-${old.getFullYear()}-${p(old.getMonth() + 1)}-${p(old.getDate())}.jsonl`;
writeFileSync(join(dir, oldName), '{}\n');
t('旧文件已造', readdirSync(dir).includes(oldName));
const res = pruneTrace(config, { keepDays: 14, now: today });
t('裁剪旧文件', res.removed === 1 && !readdirSync(dir).includes(oldName));
t('当日文件保留', readdirSync(dir).some((x) => x.endsWith('.jsonl')));
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);