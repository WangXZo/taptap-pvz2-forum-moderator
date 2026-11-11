// 动态窗口拉取（通用模块，2026-11-10）
//
// 为什么要有这个模块：
//   「只拉一页 10 条」有个静默的坑 —— 守护停机超过几小时，那批帖子就永远滑出窗口了。
//   实测一周 561 条只碰到 220 条（覆盖 39%），很多帖**根本没进过队列**。
//
// 通用做法（不绑定任何具体来源）：
//   1. 每个来源记住「上次扫到的最老一条的时间」= **游标**
//   2. 从最新往回翻页，一直翻到「时间 ≤ 游标」为止 → 停机多久都能补回来
//   3. 平时只翻 1~2 页；第一次没有游标时只补最近 backfillMs（默认 6 小时）
//
// 谁在用：
//   · scripts/watch.mjs        —— created / commented 两个 feed 源
//   · scripts/mod-watch.mjs    —— 加好友帖扫描（可按同样的方式扩大窗口）
//
// 时间轴要选对（2026-11-10 踩到）：
//   `sort=created`  → 用 publish_time
//   `sort=commented`→ 必须用 commented_time！老帖被顶时 publish_time 能是 2022 年，
//                     拿它当游标 → 游标一下跳到 2022 → 之后每轮都要翻满 maxPages 页去追。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 按「时间游标」把一个分页列表拉到足够深
 *
 * @param {object} o
 * @param {Function} o.fetchPage  `(params:{from,limit}) => Promise<{list:Array, next_page?:string}>` —— 单页取数
 * @param {object} [o.params]    传给 fetchPage 的固定参数（groupId / sort / type …）
 * @param {number} [o.limit=10]  每页条数（TapTap feed 接口硬上限 10，要更多只能翻页）
 * @param {number|null} [o.cursorMs] 上次扫到的最老时间（ms）；null = 第一次，按 backfillMs 补
 * @param {number} [o.maxPages=20]  单轮翻页上限（200 条），别往上调，容易招 WAF
 * @param {number} [o.backfillMs=6h] 第一次没有游标时补多久
 * @param {Function} [o.timeOf] `(item) => ms` —— 取这条的时间（不同来源用不同字段）
 * @param {number} [o.nowMs]
 * @param {Function} [o.log]
 * @returns {Promise<{items:Array, pages:number, oldestMs:number, cursorMs:number, reached:boolean}>}
 */
export async function fetchWindow({
  fetchPage,
  params = {},
  limit = 10,
  cursorMs = null,
  maxPages = 20,
  backfillMs = 6 * 3600 * 1000,
  timeOf = () => 0,
  nowMs = Date.now(),
  log = () => {},
} = {}) {
  const items = [];
  const target = cursorMs ?? nowMs - backfillMs;
  let from = 0;
  let pages = 0;
  let oldestMs = Infinity;
  let newestMs = 0;
  let reached = false;

  while (pages < maxPages) {
    let data;
    try {
      data = await fetchPage({ ...params, from, limit });
    } catch (e) {
      log(`  [窗口] 取第 ${pages + 1} 页失败：${e.message}`);
      break;
    }
    const list = data?.list || [];
    if (!list.length) break;
    pages++;
    for (const it of list) {
      items.push(it);
      const t = Number(timeOf(it) || 0);
      if (t && t < oldestMs) oldestMs = t;
      if (t && t > newestMs) newestMs = t;
    }
    // 翻到比「上轮高水位」还老 → 缺口补齐，收工
    if (oldestMs <= target) {
      reached = true;
      break;
    }
    if (!data?.next_page) break;
    from += limit;
  }

  return {
    items,
    pages,
    oldestMs: Number.isFinite(oldestMs) ? oldestMs : 0,
    /**
     * **高水位**：本次扫到的**最新**一条的时间 —— 下次拿它当 target。
     *
     * ⚠️ 别存「最老那条」（2026-11-10 踩过）：那等于每次都往回翻到同一个老边界，
     * 翻页深度不收敛（停机两天 → 之后每轮都翻 16 页），直接招 WAF。
     * 存高水位才是「上次看到哪儿了」——停机后从高水位往回翻，正好补上缺口，
     * 补完高水位自动前移，深度回到 1~2 页。
     */
    cursorMs: newestMs || cursorMs || 0,
    reached,
  };
}

/**
 * 游标仓库（按来源各存一个时间；落盘 → 重启不丢）
 *
 * @param {string} file 落盘路径
 * @returns {{get:(k:string)=>number|null, set:(k:string,v:number)=>void, save:()=>void, all:()=>object}}
 */
export function createCursorStore(file) {
  let data = {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) || {};
    data = typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {}
  return {
    get(k) {
      const v = Number(data[k]);
      return Number.isFinite(v) && v > 0 ? v : null;
    },
    set(k, v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) data[k] = n;
    },
    save() {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
      } catch {}
    },
    all() {
      return { ...data };
    },
  };
}
