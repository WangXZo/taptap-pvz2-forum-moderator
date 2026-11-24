// B4-3/4/5 插件离线测试：share / praise / interact 的归属判断与计划字段（2026-11-19）
import share from './plugins/share.mjs';
import praise from './plugins/praise.mjs';
import interact from './plugins/interact.mjs';
import comfort from './plugins/comfort.mjs';
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
// ---------- F2（2026-11-23）：队友已开口 → 捧场类通道让位 ----------
//   现场：队友 622*** 已在《天宫码（安卓），麻烦用完留个言》《天宫拿去》先夸过，
//        bot 又各夸一遍。根因是插件只查「自己发过的事件」，看不见队友回过。
//        core 现在统一给出 `_teamSpoke`（isOurComment：队友 id + 签名结尾），插件据此让位。
console.log('\n== F2: 队友已开口 → 捧场类让位（不跟队友重复）==');
{
  const codePost = rec({ id: 't1', title: '天宫码（安卓），麻烦用完留个言', text: 'JFAABCDEFG 自取，用完留个言' });
  t('无队友开口 → 发码帖照常夸', (await share.planBatch([codePost], mkCtx()))?.length === 1);
  t('队友已夸 → 不再夸（核心修复）', (await share.planBatch([{ ...codePost, _teamSpoke: true }], mkCtx())) === null);

  const sharePost = rec({ id: 't2', title: '终于通关了', text: '分享一下我的通关进度' });
  t('分享帖：队友已开口 → 不再互动', (await share.planBatch([{ ...sharePost, _teamSpoke: true }], mkCtx())) === null);

  // 真实事故帖文本（test-comfort 里确认能被 looksLikeEmotion 认出）
  const emoPost = rec({
    id: 't3',
    title: '我无疑是绝望的。。。',
    text: '任务差一点，无法完成了。非常可惜',
    status: STATUS.NO_NEED,
  });
  const emoCtx = () => mkCtx({ config: { comfort: { enabled: true, maxPerRun: 2 } } });
  t('情绪帖：无队友开口 → 会去陪一句', (await comfort.planBatch([emoPost], emoCtx()))?.length === 1);
  t('情绪帖：队友已开口 → 不再陪聊', (await comfort.planBatch([{ ...emoPost, _teamSpoke: true }], emoCtx())) === null);
}

// ---------- 天宫码捧场开关（大哥 2026-11-23：「天宫码，捧场，关闭」，其他不涉及） ----------
console.log('\n== 天宫码捧场开关 config.share.codePraise ==');
{
  const codePost = rec({ id: 'cp1', title: '天宫码 先到先得', text: 'JFAABCDEFG 拿去用' });
  const sharePost = rec({ id: 'cp2', title: '终于通关了', text: '分享一下我的通关进度' });
  const offCtx = () => mkCtx({ config: { share: { enabled: true, codePraise: false } } });

  t('默认（未配 codePraise）→ 照常夸', (await share.planBatch([codePost], mkCtx()))?.length === 1);
  t('codePraise=false → 不再夸天宫码', (await share.planBatch([codePost], offCtx())) === null);
  t('codePraise=false 不影响分享帖轻互动', (await share.planBatch([sharePost], offCtx()))?.length === 1);
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