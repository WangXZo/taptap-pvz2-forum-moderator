// B4-2 comfort 插件 + 执行器离线测试（2026-11-19）
import comfort from './plugins/comfort.mjs';
import { runPluginPlans, resolveMode, pluginOwns } from './lib/plugin-runner.mjs';
import { STATUS } from './lib/state.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const mkRes = (id, title, extra = {}) => ({ id, title, text: '', url: 'https://x/' + id, status: STATUS.MANUAL, ...extra });
const mkCtx = ({ emotion = true, done = [], spoke = [], canChat = true, gate = null, config = {} } = {}) => ({
  config: { comfort: { enabled: true, maxPerRun: 2 }, sceneFeedback: {}, ...config },
  log: () => {},
  state: { posts: Object.fromEntries(spoke.map((id) => [id, { shareCommented: true }])) },
  db: null,
  gate: gate || undefined,
  hasDoneEvent: (id, kind) => done.includes(`${id}:${kind}`),
  compose: async () => ({ ok: true, text: '陪着难受一下' }),
});
const _unused = { looksLikeEmotion: null };

console.log('\n== 归属判断 ==');
{
  // 用真实 looksLikeEmotion：造情绪帖
  const emotionPost = mkRes('e1', '我无疑是绝望的。。。', { text: '任务差一点没完成' });
  const r = await comfort.planBatch([emotionPost], mkCtx());
  t('情绪帖 → 产出 1 条计划', Array.isArray(r) && r.length === 1);
  t('计划字段完整', r[0].plugin === 'comfort' && r[0].level === 0 && r[0].postId === 'e1');
  t('带幂等 done', r[0].done.kind === 'comfort_reply');
  t('带 stateFlags.comforted', r[0].stateFlags.comforted === true);
  t('mutexKey 按帖', r[0].mutexKey === 'post:e1');
}
{
  const qaPost = mkRes('q1', '困难6怎么过', { text: '求攻略' });
  const r = await comfort.planBatch([qaPost], mkCtx());
  t('提问帖 → 不归我（null）', r === null);
}
console.log('\n== 去重与闸门 ==');
{
  const p = mkRes('e2', '绝望');
  t('已安慰过 → 跳过', (await comfort.planBatch([p], mkCtx({ done: ['e2:comfort_reply'] }))) === null);
  t('本轮已开口（分享）→ 跳过', (await comfort.planBatch([p], mkCtx({ spoke: ['e2'] }))) === null);
  t('场景冷却 → 跳过', (await comfort.planBatch([p], mkCtx({ gate: { ok: false, reason: '冷却' } }))) === null);
}
console.log('\n== 上限 ==');
{
  const posts = ['a', 'b', 'c'].map((id) => mkRes(id, '绝望', { text: '难受' }));
  const r = await comfort.planBatch(posts, mkCtx({ config: { comfort: { enabled: true, maxPerRun: 2 } } }));
  t('按 maxPerRun 截断为 2', r.length === 2);
}
console.log('\n== 生成失败不产计划 ==');
{
  const p = mkRes('e3', '绝望', { text: '难受' });
  const ctx = { ...mkCtx(), compose: async () => ({ ok: false, reason: 'llm_failed' }) };
  t('生成失败 → null', (await comfort.planBatch([p], ctx)) === null);
}
console.log('\n== 开关关闭 ==');
{
  const p = mkRes('e4', '绝望', { text: '难受' });
  t('comfort.enabled=false → null', (await comfort.planBatch([p], mkCtx({ config: { comfort: { enabled: false } } }))) === null);
}

console.log('\n== 执行器模式解析 ==');
{
  t('全关 → off', resolveMode({ plugins: {} }) === null);
  t('shadow → shadow', resolveMode({ plugins: { comfort: 'shadow' } }) === 'shadow');
  t('有 true → real', resolveMode({ plugins: { comfort: true } }) === 'real');
  t('pluginOwns 只认 true', pluginOwns({ plugins: { comfort: true } }, 'comfort') === true && pluginOwns({ plugins: { comfort: 'shadow' } }, 'comfort') === false);
}

console.log('\n== 执行器 shadow 不发 ==');
{
  const sent = [];
  const r = await runPluginPlans({
    plugins: [{ id: 'comfort', plugin: comfort }],
    results: [mkRes('e5', '绝望', { text: '难受' })],
    config: { plugins: { comfort: 'shadow' }, comfort: { maxPerRun: 2 }, sceneFeedback: {} },
    state: { posts: {} },
    hasDoneEvent: () => false,
    compose: async () => ({ ok: true, text: '陪你一下' }),
    log: () => {},
    sendLayerImpl: { send: async (p) => { sent.push(p); return { ok: true }; } },
  });
  t('产出 1 条计划', r.plans.length === 1);
  t('shadow 不调用发送', sent.length === 0);
  t('sent 计数 0', r.sent === 0);
}

console.log('\n== 执行器 real 真发（stub 发送层）==');
{
  const sent = [];
  const r = await runPluginPlans({
    plugins: [{ id: 'comfort', plugin: comfort }],
    results: [mkRes('e6', '绝望', { text: '难受' })],
    config: { plugins: { comfort: true }, comfort: { maxPerRun: 2 }, sceneFeedback: {}, exec: { concurrency: 1 } },
    state: { posts: {} },
    hasDoneEvent: () => false,
    compose: async () => ({ ok: true, text: '陪你一下' }),
    log: () => {},
    sendLayerImpl: { send: async (p) => { sent.push(p); return { ok: true }; } },
  });
  t('调用了发送层', sent.length === 1);
  t('sent=1', r.sent === 1);
  t('mode=real', r.mode === 'real');
  t('发给正确帖子', sent[0].postId === 'e6');
}

console.log('\n== 执行器 dryRun 不发 ==');
{
  const sent = [];
  const r = await runPluginPlans({
    plugins: [{ id: 'comfort', plugin: comfort }],
    results: [mkRes('e7', '绝望', { text: '难受' })],
    config: { plugins: { comfort: true }, comfort: { maxPerRun: 2 }, sceneFeedback: {} },
    state: { posts: {} },
    hasDoneEvent: () => false,
    compose: async () => ({ ok: true, text: '陪你一下' }),
    log: () => {},
    dryRun: true,
    sendLayerImpl: { send: async (p) => { sent.push(p); return { ok: true }; } },
  });
  t('dryRun 不调发送层', sent.length === 0);
  t('仍产出计划', r.plans.length === 1);
}

console.log('\n== 插件异常隔离 ==');
{
  const bad = { id: 'bad', planBatch: async () => { throw new Error('boom'); } };
  const r = await runPluginPlans({
    plugins: [{ id: 'bad', plugin: bad }, { id: 'comfort', plugin: comfort }],
    results: [mkRes('e8', '绝望', { text: '难受' })],
    config: { plugins: { comfort: true }, comfort: { maxPerRun: 2 }, sceneFeedback: {} },
    state: { posts: {} },
    hasDoneEvent: () => false,
    compose: async () => ({ ok: true, text: 'x' }),
    log: () => {},
    sendLayerImpl: { send: async () => ({ ok: true }) },
  });
  t('坏插件不影响好的（仍产出 1 条）', r.plans.length === 1);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);