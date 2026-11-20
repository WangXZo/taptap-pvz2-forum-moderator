// O10 v2 决策路径单测（2026-11-19）：检索→验证→fact 被拒回退问答层。
import { decideV2 } from './lib/decision.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const post = { title: '摇滚无尽怎么打', text: '求阵容' };
const config = { match: { suggestScore: 0.45 } };
const qa = [{ id: 'q1', question: '摇滚无尽阵容', answer: 'a' }];
const db = {};

const factRR = { source: 'fact', score: 1, entry: { id: 'f1', question: '摇滚无尽', confidence: 50, attrs: { 特点: '巨人多' } }, candidates: [{ question: '摇滚无尽', score: 1 }] };
const qaRR = { source: 'qa', score: 0.7, entry: qa[0], candidates: [{ question: '摇滚无尽阵容', score: 0.7 }] };
const noneRR = { source: 'qa', score: 0.1, entry: null, candidates: [] };

console.log('\n== 命中直通 ==');
{
  const r = await decideV2({
    post, qa, db, config,
    retrieveImpl: async () => qaRR,
    verifyImpl: async () => ({ ok: true, tier: 'high', judgeOk: true }),
  });
  t('stage=hit', r.stage === 'hit');
  t('未回退', r.usedFallback === false);
  t('返回 qa entry', r.rr.entry.id === 'q1');
}

console.log('\n== fact 被拒 → 回退问答层 ==');
{
  let calls = 0;
  const r = await decideV2({
    post, qa, db, config,
    retrieveImpl: async (_p, o) => { calls++; return o.skipFacts ? qaRR : factRR; },
    verifyImpl: async (_p, e) => ({ ok: e.id === 'q1', tier: e.id === 'q1' ? 'mid' : 'abstain', judgeOk: e.id === 'q1' }),
  });
  t('调用两次（含 skipFacts 回退）', calls === 2);
  t('stage=fallback', r.stage === 'fallback');
  t('usedFallback=true', r.usedFallback === true);
  t('回退后取 qa 条目', r.rr.entry.id === 'q1' && r.rr.source === 'qa');
  t('回退后验证通过', r.v.ok === true);
}

console.log('\n== fact 被拒且问答层也不达标 → abstain ==');
{
  const r = await decideV2({
    post, qa, db, config,
    retrieveImpl: async (_p, o) => (o.skipFacts ? qaRR : factRR),
    verifyImpl: async () => ({ ok: false, tier: 'abstain', judgeOk: false }),
  });
  t('stage=abstain', r.stage === 'abstain');
  t('usedFallback=false（回退也没救回）', r.usedFallback === false);
  t('保留原 fact 结果供归因', r.rr.entry.id === 'f1');
}

console.log('\n== 问答层直接不达标 → abstain（不回退）==');
{
  let calls = 0;
  const r = await decideV2({
    post, qa, db, config,
    retrieveImpl: async () => { calls++; return qaRR; },
    verifyImpl: async () => ({ ok: false, tier: 'abstain', judgeOk: false }),
  });
  t('只调一次（qa 无回退）', calls === 1);
  t('stage=abstain', r.stage === 'abstain');
}

console.log('\n== 检索无命中 / 分数不够 ==');
{
  let verified = 0;
  const r = await decideV2({ post, qa, db, config, retrieveImpl: async () => noneRR, verifyImpl: async () => { verified++; return { ok: true }; } });
  t('stage=nomatch', r.stage === 'nomatch');
  t('不调 verify', verified === 0);
  const r2 = await decideV2({ post, qa, db, config: { match: { suggestScore: 0.9 } }, retrieveImpl: async () => qaRR, verifyImpl: async () => ({ ok: true }) });
  t('分数低于 suggestScore → nomatch', r2.stage === 'nomatch');
}

console.log('\n== 默认 suggestScore 0.45 ==');
{
  const r = await decideV2({ post, qa, db, config: {}, retrieveImpl: async () => ({ ...qaRR, score: 0.44 }), verifyImpl: async () => ({ ok: true }) });
  t('0.44 < 0.45 → nomatch', r.stage === 'nomatch');
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);