// C9 评测 harness 离线测试（P3，2026-11-18）：toneScan + runEval(注入 stub) + 报告渲染。
import { toneScan, runEval, renderReport } from './lib/eval.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== toneScan 口吻+护栏 ==');
t('玩家口语过', toneScan('哇瓷砖萝卜！2888十连直接抱走，血赚啊，攒了多久钻？').ok);
t('AI 味拦', !toneScan('总体来看该关卡难度较高，建议您消耗钻石通过。').ok);
t('客服腔拦', !toneScan('亲爱的玩家，建议您联系客服处理。').ok);
t('泄露拦', !toneScan('我查了答疑库才知道的').ok);

console.log('\n== runEval（注入 stub，零 LLM）==');
const factRet = { source: 'fact', score: 1, entry: { id: 'box', question: '钻石宝箱抽取', confidence: 95, answer: '十连', attrs: { pulls: 10 } }, candidates: [{ question: '钻石宝箱抽取', score: 1 }] };
const stubRetrieve = async (post) => (post.imageEntities?.length || /688|2888/.test(`${post.title} ${post.text}`))
  ? factRet
  : { source: 'qa', score: 0.8, entry: { id: 'q1', question: '关卡打不过怎么办', confidence: 95, answer: '慢慢来' }, candidates: [{ question: '关卡打不过怎么办', score: 0.8 }] };
const stubVerify = async () => ({ ok: true, tier: 'high', judgeOk: true });
const stubCompose = async () => ({ ok: true, text: '这关耗钻加运气，200钻就过了，你卡多久了？' });
const stubFaith = async () => true;
const set = [
  { id: 'a', title: '蹲一个天宫码', text: '', expect: { intent: 'code', skip: true } },
  { id: 'b', title: '688是单抽还是十连', text: '', expect: { intent: 'qa', source: 'fact', entryIncludes: '钻石宝箱', tier: 'high' } },
  { id: 'c', title: '困难6怎么过', text: '', expect: { intent: 'qa', source: 'qa', entryIncludes: '关卡打不过' } },
  { id: 'd', title: '终于抽到瓷砖萝卜了', text: '', expect: { intent: 'celebrate' } },
  { id: 'e', title: '看图', text: '', imageEntities: ['688'], expect: { source: 'fact', entryIncludes: '钻石宝箱' } },
];
const ov = { retrieve: stubRetrieve, verify: stubVerify, compose: stubCompose, faith: stubFaith };
let res = await runEval({ config: {}, qa: [], db: null, set, llm: false, overrides: ov });
t('规则模式不跑 LLM 指标', res.metrics.tonePass === null && res.metrics.faithPass === null);
t('路由全对', res.metrics.routeAcc === 1);
t('静默正确', res.metrics.skipAcc === 1);
t('召回@5 全对', res.metrics.recall5 === 1);
t('C8 实体 case 召回', res.cases.find((c) => c.id === 'e').recall5 === true);
res = await runEval({ config: {}, qa: [], db: null, set, llm: true, overrides: ov });
t('llm 模式口吻过', res.metrics.tonePass === 1);
t('llm 模式忠实过', res.metrics.faithPass === 1);
t('llm 模式分档对', res.metrics.tierAcc === 1);
t('生成成功', res.metrics.genOk === 1);
const md = renderReport(res, { mode: 'llm', config: { pipeline: 'v2' } });
t('报告含指标表', md.includes('recall5') && md.includes('faithPass'));
t('报告含逐 case', md.includes('| b |') && md.includes('钻石宝箱'));
// 坏 case 进回归清单
const badSet = [{ id: 'x', title: '困难6怎么过', text: '', expect: { intent: 'celebrate' } }];
const badRes = await runEval({ config: {}, qa: [], db: null, set: badSet, llm: false, overrides: ov });
t('错路由被记 ✗', badRes.cases[0].routeOk === false);
t('报告列 bad-case', renderReport(badRes, {}).includes('未达标 case'));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);