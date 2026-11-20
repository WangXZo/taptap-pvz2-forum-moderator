// 弃答归类 + 评测候选离线测试（2026-11-18）
import { classifyAbstain, appendEvalCandidate, ABSTAIN_REASON } from './lib/abstain.mjs';
import { STATUS } from './lib/state.mjs';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== classifyAbstain ==');
t('真提问 → 需人工', classifyAbstain({ looksQ: true }).status === STATUS.MANUAL);
t('真提问 → needsHuman=true', classifyAbstain({ looksQ: true }).needsHuman === true);
t('非提问 → 无需回复', classifyAbstain({ looksQ: false }).status === STATUS.NO_NEED);
t('非提问 → needsHuman=false', classifyAbstain({ looksQ: false }).needsHuman === false);
t('reason 统一', classifyAbstain({}).reason === ABSTAIN_REASON);

console.log('\n== appendEvalCandidate ==');
const dir = mkdtempSync(join(tmpdir(), 'cand-'));
const config = { paths: { dataDir: dir }, evalCandidates: { enabled: true } };
const ok1 = appendEvalCandidate(config, { postId: 'p1', title: '怎么打黄瓜', text: '僵尸不出下一波', reason: ABSTAIN_REASON, tier: 'abstain', entryId: 'e1', intent: 'qa' });
t('首次写入成功', ok1 === true);
const file = join(dir, 'eval-candidates.jsonl');
t('文件已创建', existsSync(file));
const line = JSON.parse(readFileSync(file, 'utf8').trim());
t('字段齐全', line.postId === 'p1' && line.tier === 'abstain' && line.intent === 'qa');
t('标题截断保留', line.title.includes('怎么打黄瓜'));
const ok2 = appendEvalCandidate(config, { postId: 'p1', title: '重复', text: '' });
t('同 postId 去重', ok2 === false);
t('去重后仍 1 行', readFileSync(file, 'utf8').trim().split('\n').length === 1);
const ok3 = appendEvalCandidate(config, { postId: 'p2', title: '另一帖', text: '' });
t('不同 postId 追加', ok3 === true && readFileSync(file, 'utf8').trim().split('\n').length === 2);
t('无 postId 直接跳过', appendEvalCandidate(config, { title: 'x' }) === false);
t('开关关闭不写', appendEvalCandidate({ ...config, evalCandidates: { enabled: false } }, { postId: 'p3' }) === false);
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);