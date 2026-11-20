// C10 插件加载器（2026-11-17 P0-M1；2026-11-19 B4 扩展 planBatch）
// 功能模块（image/praise/share/comfort/interact/codematch/review/weekly/comment/mod）独立成 plugins/<id>.mjs，
// 经 hooks 被内核调用；单插件异常不拖垮内核。resolve 可注入（测试用 stub），默认真实 dynamic import。
//
// 钩子（B4 起）：
//   init(ctx)                        初始化
//   onPost(item, ctx)                帖级前置（image 用：取图/识别/回灌）
//   planBatch(results, ctx)          帖后**批量规划** → Plan[] | null（null = 这帖/这批不归我）
//   scheduled(ctx)                   周期任务（P4 用）
//
// 为什么用 planBatch 而不是逐帖 plan：
//   现有各通道（夸奖/分享/情绪/互动）本质是**批量闸门**（跨帖上限 + 场景闸 + 去重），
//   逐帖接口会把这些闸门拆散到内核，反而增加耦合与回归风险。planBatch 保持"整块自治"。

export const PLUGIN_IDS = ['image', 'praise', 'share', 'comfort', 'interact', 'codematch', 'review', 'weekly', 'comment', 'mod'];
const DEFAULT_ON = new Set(['image']); // 渐进：image 默认开，其余按 config.features / config.plugins 决定

export async function loadPlugins(config, ctx, { resolve } = {}) {
  const feats = { ...(config?.features || {}), ...(config?.plugins || {}) };
  const load = resolve || ((id) => import(`../plugins/${id}.mjs`));
  const loaded = [];
  for (const id of PLUGIN_IDS) {
    const on = feats[id] !== undefined ? feats[id] !== false : DEFAULT_ON.has(id);
    if (!on) continue;
    try {
      const mod = await load(id);
      const plugin = mod?.default || mod;
      if (plugin?.init) await plugin.init(ctx);
      loaded.push({ id, plugin });
    } catch (e) {
      ctx?.log?.(`  [插件] ${id} 加载跳过（${e.message}）`);
    }
  }
  return loaded;
}

/** 内核钩子：把帖子分发给已加载插件的 onPost，收集 actions */
export async function dispatchPost(loaded, post, ctx) {
  const actions = [];
  for (const { id, plugin } of loaded) {
    if (!plugin?.onPost) continue;
    try {
      const r = await plugin.onPost(post, ctx);
      if (Array.isArray(r)) actions.push(...r.map((a) => ({ ...a, plugin: id })));
    } catch (e) {
      ctx?.log?.(`  [插件] ${id} onPost 异常（${e.message}）→ 隔离跳过`);
    }
  }
  return actions;
}

/**
 * 批量规划（B4）：**并行**调用各插件的 planBatch，各自返回 Plan[] 或 null。
 * 并行是刻意的（大哥 2026-11-19）：意图之间无依赖，串行只是为了避免并发执行，不是规划。
 * @returns {Promise<Array>} 扁平化的 plans（每个带 plugin 字段）
 */
export async function dispatchPlanBatch(loaded, results, ctx) {
  const list = (loaded || []).filter((p) => typeof p.plugin?.planBatch === 'function');
  const settled = await Promise.all(
    list.map(async ({ id, plugin }) => {
      try {
        const r = await plugin.planBatch(results, ctx);
        if (!r) return [];
        const arr = Array.isArray(r) ? r : [r];
        return arr.filter(Boolean).map((p) => ({ ...p, plugin: p.plugin || id }));
      } catch (e) {
        ctx?.log?.(`  [插件] ${id} planBatch 异常（${e.message}）→ 隔离跳过`);
        return [];
      }
    })
  );
  return settled.flat();
}

/** 周期任务（P4 预留）：只调有 scheduled 的插件 */
export async function dispatchScheduled(loaded, ctx) {
  const out = [];
  for (const { id, plugin } of loaded || []) {
    if (typeof plugin?.scheduled !== 'function') continue;
    try {
      out.push({ id, result: await plugin.scheduled(ctx) });
    } catch (e) {
      ctx?.log?.(`  [插件] ${id} scheduled 异常（${e.message}）→ 隔离跳过`);
    }
  }
  return out;
}