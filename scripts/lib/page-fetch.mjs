// 页面上下文 fetcher 注入器（用户 2026-11-06）
//
// 为什么需要单独一个模块：
//   `lib/http.mjs` 不能依赖 opencli（它要保持「零依赖、可离线」），
//   但匿名通道随时可能被 WAF 拦（而且**必须人工验证才能解除**）。
//   所以由守护进程/采集器在启动时把「页面内 fetch」注入进去：
//     setPageFetcher(createPageFetcher({ config, log }))
//   之后 listFeed / listComments 会**优先走页面**（带 Cookie），失败再退回匿名。
//
// 页面通道拿不到（Chrome 没开 / 扩展没连 / 页面不在 taptap 域）→ 返回 null，自动降级。

import { makeRunner } from './replier.mjs';
import { getTapApi } from './taptap-api.mjs';

/**
 * @param {object} o
 * @param {object} o.config
 * @param {Function} [o.log]
 * @returns {((path:string, params:object)=>Promise<object|null>)|null}
 */
export function createPageFetcher({ config = {}, log = () => {} } = {}) {
  let api = null;
  try {
    const runner = makeRunner({
      opencliMain: config.reply?.opencliMain,
      session: config.reply?.session,
    });
    if (!runner.available) {
      log('  [页面通道] opencli 不可用 → 只用匿名接口');
      return null;
    }
    api = getTapApi({ runner, log });
    if (!api.ensureOrigin().ok) {
      log('  [页面通道] 当前标签不在 taptap 域 → 只用匿名接口');
      return null;
    }
  } catch (e) {
    log(`  [页面通道] 初始化失败（${e.message}）→ 只用匿名接口`);
    return null;
  }

  /**
   * @param {string} path 形如 `/webapiv2/feed/v7/by-group`
   * @param {object} params
   * @returns {Promise<object|null>} 成功返回 `json.data`，失败返回 null（交给匿名兜底）
   */
  return async function pageFetch(path, params) {
    try {
      const r = await api.get(path, params);
      if (!r.ok) return null;
      const data = r.json?.data;
      return data || null;
    } catch {
      return null;
    }
  };
}