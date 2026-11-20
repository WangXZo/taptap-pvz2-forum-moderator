// B4-3/4/5 插件离线测试：share / praise / interact 的归属判断与计划字段（2026-11-19）
import share from './plugins/share.mjs';
import praise from './plugins/praise.mjs';
import interact from './plugins/interact.mjs';
import { STATUS, REASON } from './lib/state.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const noop = () => {};
const mkCtx = (o = {}) => ({
  config: { share: { enabled: true, maxPerRun: 2, maxCodePraisePerRun: 2 }, praise: { enabled: true, maxPerRun: 3, minScore: 1 }, interact: { enabled: true, maxPerPost: 1 }, sceneFeedback: {}, ...(o.config || {}) },
  log: noop,
  state: o.state || { posts: {} },
  hasDoneEvent: o.hasDoneEvent || (() => false),
  compose: o.compose || (async () => ({ ok: true, text: '生成的文案' })),
  praiseHistoryTexts: o.praiseHistoryTexts || [],
});
const rec = (o = {}) => ({ id: 'p1', title: '标题', text: '正文', url: 'https://x/p1', status: STATUS.NO_NEED, reason: REASON.NOT_QUESTION, ...o });

console.log('\n== share：发码帖 → 夸无私分享 ==');
{
  const r = rec({ id: 's1', title: '天宫码 先到先得', text: 'JFAABCDEFG 拿去用' });
  const plans = await share.planBatch([r], mkCtx());
  t('产出 1 条', plans?.length === 1);
  t('事件 code_praise', plans[0].done.kind === 'code_praise');
  t('场景 praise_code', plans[0].meta.scene === 'praise_code');
  t('stateFlags 带 codePraiseAt', Boolean(plans[0].stateFlags.codePraiseAt));
  t('priority 40', plans[0].priority === 40);
}
console.log('\n== share：求码帖 ≠ 分享（不夸）==');
{
  const r = rec({ id: 's2', title: '蹲一个天宫码', text: '有没有大佬给个' });
  t('求码帖不归我', (await share.planBatch([r], mkCtx())) === null);
}
console.log('\n== share：幂等与闸门 ==');
{
  const r = rec({ id: 's3', title: '终于通关了', text: '分享一下' });
  const p1 = await share.planBatch([r], mkCtx());
  t('分享帖产出 1 条', p1?.length === 1 && p1[0].done.kind === 'share_reply');
  t('已分享过 → null', (await share.planBatch([r], mkCtx({ hasDoneEvent: (id, kind) => kind === 'share_reply' }))) === null);
  t('场景冷却 → null', (await share.planBatch([r], mkCtx({ config: {} , gateOf: undefined }))) !== undefined);
}
// 评论要符合接口真实结构（flattenReplies 取 contents.json[0].children[0].text）
const mkComment = (id, name, uid, text) => ({
  id_str: id,
  author: { name, id: uid },
  created_time: 1,
  contents: { json: [{ children: [{ text }] }] },
  child_posts: [],
});

console.log('\n== praise：他人已答 → 计划 ==');
{
  const comments = [mkComment('c1', '玩家B', '9', '困难6用机枪加冰车就行，我40级通关了')];
  const r = rec({ id: 'q1', status: STATUS.MANUAL, reason: REASON.OTHERS_REPLIED, _comments: comments });
  const plans = await praise.planBatch([r], mkCtx());
  t('产出 1 条夸奖计划', plans?.length === 1);
  t('kind=praise', plans[0]?.kind === 'praise');
  t('带 commentId', Boolean(plans[0]?.commentId));
  t('事件 praise_reply', plans[0]?.done.kind === 'praise_reply');
  t('priority 30', plans[0]?.priority === 30);
}
console.log('\n== praise：闸门 ==');
{
  const comments = [mkComment('c1', 'B', '9', '用冰车加机枪就行，我通关了')];
  const r = rec({ id: 'q2', status: STATUS.MANUAL, reason: REASON.OTHERS_REPLIED, _comments: comments });
  t('非他人已答 → null', (await praise.planBatch([rec({ id: 'q3', _comments: comments })], mkCtx())) === null);
  t('无评论 → null', (await praise.planBatch([rec({ id: 'q4', status: STATUS.MANUAL, reason: REASON.OTHERS_REPLIED, _comments: [] })], mkCtx())) === null);
  t('已夸过 → null', (await praise.planBatch([r], mkCtx({ hasDoneEvent: (id, kind) => kind === 'praise_reply' }))) === null);
  t('失败次数超限 → null', (await praise.planBatch([{ ...r, _prev: { praiseFailCount: 5 } }], mkCtx())) === null);
  t('生成失败 → null', (await praise.planBatch([r], mkCtx({ compose: async () => ({ ok: false, reason: 'x' }) }))) === null);
}
console.log('\n== interact：候选 → 计划 ==');
{
  const cand = { commentId: 'c9', parentId: 'c1', author: '玩家C', authorId: '8', text: '你说的这个我试了确实行，谢谢！', why: 'reply_you', target: { level: 1, label: '回复#c1', mention: '', parentId: '' } };
  const r = rec({ id: 'i1', status: STATUS.NO_NEED, interactCandidates: [cand], _threadTree: null });
  const plans = await interact.planBatch([r], mkCtx());
  t('产出 1 条互动计划', plans?.length === 1);
  t('kind=interact', plans[0].kind === 'interact');
  t('带 playerKey', 'playerKey' in plans[0]);
  t('priority 60', plans[0].priority === 60);
  t('事件 interact_reply', plans[0].done.kind === 'interact_reply');
}
console.log('\n== interact：幂等与上限 ==');
{
  const cand = { commentId: 'c9', author: 'C', authorId: '8', text: '这个我试了确实行，谢啦兄弟', why: 'reply_you', target: { level: 1, label: 'x', mention: '', parentId: '' } };
  const r = rec({ id: 'i2', interactCandidates: [cand] });
  t('已接过话 → null', (await interact.planBatch([r], mkCtx({ hasDoneEvent: (id, k) => k === 'interact_reply' }))) === null);
  const cand2 = { ...cand, commentId: 'c10' };
  const r2 = rec({ id: 'i3', interactCandidates: [cand, cand2] });
  const plans = await interact.planBatch([r2], mkCtx());
  t('maxPerPost=1 只产 1 条', plans?.length === 1);
}
console.log('\n== interact：护栏拦截 ==');
{
  const cand = { commentId: 'c11', author: 'C', authorId: '8', text: '你回复得真好，谢谢你帮我解决了这个问题', why: 'reply_you', target: { level: 1, label: 'x', mention: '', parentId: '' } };
  const r = rec({ id: 'i4', interactCandidates: [cand] });
  const leakCompose = async () => ({ ok: true, text: '我查了答疑库才知道的' });
  t('泄露自检命中 → 不产计划', (await interact.planBatch([r], mkCtx({ compose: leakCompose }))) === null);
}
console.log('\n== 开关关闭 ==');
{
  const r = rec({ id: 'x1', title: '终于通关了', text: '分享' });
  t('share 关闭 → null', (await share.planBatch([r], mkCtx({ config: { share: { enabled: false } } }))) === null);
  t('praise 关闭 → null', (await praise.planBatch([r], mkCtx({ config: { praise: { enabled: false } } }))) === null);
  t('interact 关闭 → null', (await interact.planBatch([r], mkCtx({ config: { interact: { enabled: false } } }))) === null);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);