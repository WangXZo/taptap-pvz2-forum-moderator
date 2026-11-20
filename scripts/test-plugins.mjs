// 插件加载器离线测试（P0-M1，2026-11-17）—— stub resolver，不依赖真实插件文件。
import { loadPlugins, dispatchPost, PLUGIN_IDS } from './lib/plugins.mjs';

let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const stub = (id) => ({
  default: {
    id,
    init: async (ctx) => { ctx.inited = (ctx.inited || []).concat(id); },
    onPost: async (post) => (post.hit === id ? [{ type: 'act', id }] : []),
  },
});
const resolve = async (id) => stub(id);

console.log('\n== loadPlugins 按需加载 ==');
{
  const ctx = {};
  const loaded = await loadPlugins({ features: { image: true, review: true, weekly: false } }, ctx, { resolve });
  t('image+review 加载', loaded.map((l) => l.id).join(',') === 'image,review');
  t('weekly 关闭不加载', !loaded.some((l) => l.id === 'weekly'));
  t('init 被调用', (ctx.inited || []).join(',') === 'image,review');
}
{
  const loaded = await loadPlugins({ features: { image: false } }, {}, { resolve });
  t('显式关闭 image → 不加载', loaded.length === 0);
}
{
  const loaded = await loadPlugins({}, {}, { resolve });
  t('默认只开 image', loaded.map((l) => l.id).join(',') === 'image');
}
{
  const badResolve = async (id) => { if (id === 'image') throw new Error('missing'); return stub(id); };
  const loaded = await loadPlugins({ features: { image: true, review: true } }, {}, { resolve: badResolve });
  t('单插件缺失隔离跳过', loaded.map((l) => l.id).join(',') === 'review');
}

console.log('\n== dispatchPost 钩子+隔离 ==');
{
  const loaded = await loadPlugins({ features: { image: true, review: true } }, {}, { resolve });
  const acts = await dispatchPost(loaded, { hit: 'image' }, {});
  t('onPost 收集 actions', acts.length === 1 && acts[0].plugin === 'image');
  const throwResolve = async (id) => ({ default: { onPost: async () => { throw new Error('boom'); } } });
  const bad = await loadPlugins({ features: { image: true } }, {}, { resolve: throwResolve });
  const acts2 = await dispatchPost(bad, {}, {});
  t('onPost 异常隔离不抛', Array.isArray(acts2) && acts2.length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);