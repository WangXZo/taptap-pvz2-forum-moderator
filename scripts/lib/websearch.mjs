// 联网搜索适配层（薄壳）
//
// 为什么是「薄壳」而不是把代码抄一遍：
//   百度搜索这套逻辑（结果页 → 抠内嵌 sseApi → SSE 拼答案 → 没 sseApi 退结果页）
//   是**通用能力**，已经单独抽成 skill `baidu-websearch`，其它项目也能直接用。
//   这里只负责「找到它、调用它、失败就静默降级」——
//   taptap skill 里不复制实现，避免两份代码各自漂移。
//
// 找不到 baidu-websearch（比如别人只拷了 taptap 这个 skill）→ 返回 null，
// 调用方按「没搜到」处理即可，不影响主流程。
//
// 调用约定（2026-11-12 起，配合 baidu-websearch 的三级返回）：
//   ok:true  mode:'answer' → 有 AI 答案，可按 50% 中概率作答
//   ok:true  mode:'page'   → 只有结果页整理，**不当答案用**，只可当线索
//   ok:false reason:...    → 配额用完 / 被风控 / HTTP 错 / 搜不到，一律转人工

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 找 baidu-websearch 的入口文件：先 DSH skills 目录，再同级的兄弟目录 */
export function resolveWebsearchEntry() {
  // 显式覆盖（多项目共用 / 测试用）：
  //   指向具体文件路径 → 用这个
  //   设为 'none'      → 明确禁用（本项目不联网）
  const override = process.env.DSH_BAIDU_WEBSEARCH;
  if (override === 'none') return null;
  const candidates = [
    ...(override ? [override] : []),
    resolve(homedir(), '.dsh', 'skills', 'baidu-websearch', 'scripts', 'websearch.mjs'),
    resolve(homedir(), '.openclaw', 'skills', 'baidu-websearch', 'scripts', 'websearch.mjs'),
    // skill 目录同级（有人把两个 skill 放在同一父目录下）
    resolve(process.cwd(), '..', 'baidu-websearch', 'scripts', 'websearch.mjs'),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

/**
 * 仅供测试：清空模块缓存，让下一次调用重新解析入口（配合 DSH_BAIDU_WEBSEARCH）
 * 业务代码别用。
 */
export function _resetForTest() {
  mod = null;
  loadTried = false;
}

let mod = null;
let loadTried = false;

async function loadMod(log) {
  if (!loadTried) {
    loadTried = true;
    const entry = resolveWebsearchEntry();
    if (!entry) {
      log('  [搜索] 没找到 baidu-websearch skill → 跳过联网补充');
      return null;
    }
    try {
      mod = await import(pathToFileURL(entry).href);
      log(`  [搜索] 已加载 baidu-websearch（${entry}）`);
    } catch (e) {
      log(`  [搜索] 加载失败（${e.message}）→ 跳过联网补充`);
      return null;
    }
  }
  return mod;
}

/**
 * 每轮业务处理开头调用：重置单轮查询配额（上限 2 次，由 baidu-websearch 自己管）
 * @returns {Promise<void>}
 */
export async function resetSearchRound(log = () => {}) {
  const m = await loadMod(log);
  try {
    m?.resetRound?.();
  } catch {}
}

/** 本轮还剩几次查询额度（没加载到 skill 时返回 Infinity，不误拦） */
export function searchQuotaLeft() {
  try {
    return mod?.quotaLeft ? mod.quotaLeft() : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * 搜一次（答案优先，退化到结果页；配额与重抓都在 skill 内部处理）
 *
 * @param {string} query
 * @param {object} [o]
 * @param {'auto'|'answer'|'page'} [o.mode='auto']
 * @param {number} [o.timeoutMs=60000] 等答案的软上限（流式，到点保留已收到的部分）
 * @param {Function} [o.log]
 * @returns {Promise<null|{ok:boolean, mode:'answer'|'page'|'none', reason:string,
 *   detail:string, text:string, answer:string, refs:string[], titles:string[], ms:number, error?:string}>}
 *   null = 没装 baidu-websearch skill（调用方按「没搜到」处理）
 */
export async function websearch(query, { mode = 'auto', timeoutMs = 60000, log = () => {} } = {}) {
  const m = await loadMod(log);
  if (!m) return null;
  if (!query || !String(query).trim()) return null;

  try {
    if (typeof m.search !== 'function') {
      // 兼容旧版 skill（只有 fetchSerp / fetchAnswer）
      const page = await m.fetchSerp(query);
      if (page?.blocked) {
        log('  [搜索] 结果页疑似被风控 → 放弃');
        return { ok: false, mode: 'none', reason: 'blocked', detail: '被百度风控', text: '', answer: '', refs: [], titles: [], ms: 0 };
      }
      const titles = (page?.results || []).map((r) => r.title).filter(Boolean).slice(0, 8);
      if (!page?.sseApi) {
        log(`  [搜索] 旧版 skill 且没 sseApi → 只拿到 ${titles.length} 条标题`);
        return { ok: false, mode: 'none', reason: 'empty', detail: '没 sseApi', text: '', answer: '', refs: [], titles, ms: page?.ms || 0 };
      }
      const ans = await m.fetchAnswer(page.sseApi, query, { timeoutMs });
      if (!ans?.ok) {
        return { ok: false, mode: 'none', reason: 'error', detail: ans?.error || '答案为空', text: '', answer: '', refs: [], titles, ms: ans?.ms || 0 };
      }
      return { ok: true, mode: 'answer', reason: '', detail: `答案 ${ans.answer.length} 字`, text: ans.answer, answer: ans.answer, refs: ans.refs, titles, ms: ans.ms };
    }

    const r = await m.search(query, { mode, timeoutMs });
    const titles = (r?.results || []).map((x) => x.title).filter(Boolean).slice(0, 8);
    if (!r?.ok) {
      const tip =
        r?.reason === 'quota'
          ? '本轮搜索配额用完'
          : r?.reason === 'blocked'
            ? '被百度风控（需人工验证）'
            : r?.detail || '没搜到';
      log(`  [搜索] 失败（${r?.reason}）：${tip}`);
      return {
        ok: false,
        mode: 'none',
        reason: r?.reason || 'error',
        detail: r?.detail || tip,
        text: '',
        answer: '',
        refs: [],
        titles,
        ms: r?.ms || 0,
      };
    }
    if (r.mode === 'answer') {
      log(`  [搜索] 命中答案：${r.answer.length} 字 / 引用 ${r.refs.length} 条 / ${r.ms}ms`
        + (r.attempts > 1 ? `（重抓 ${r.attempts} 次）` : ''));
      return {
        ok: true,
        mode: 'answer',
        reason: '',
        detail: r.detail,
        text: r.text,
        answer: r.answer,
        refs: r.refs,
        titles,
        ms: r.ms,
      };
    }
    // mode === 'page'：只有结果页，不能当答案用
    log(`  [搜索] 只有结果页（${titles.length} 条标题）→ 仅作线索：${r.detail}`);
    return {
      ok: true,
      mode: 'page',
      reason: '',
      detail: r.detail,
      text: r.text,
      answer: '',
      refs: (r.results || []).map((x) => x.url).filter(Boolean).slice(0, 5),
      titles,
      ms: r.ms,
    };
  } catch (e) {
    log(`  [搜索] 异常（${e.message}）→ 跳过`);
    return null;
  }
}

/** 只抓结果页（快，不给答案）—— 目前只用于排查/报道，不参与答疑 */
export async function websearchTitles(query, { log = () => {} } = {}) {
  const m = await loadMod(log);
  if (!m) return null;
  try {
    if (typeof m.search === 'function') {
      const r = await m.search(query, { mode: 'page' });
      if (!r.ok) return null;
      return (r.results || []).map((x) => ({ title: x.title, url: x.url }));
    }
    const page = await m.fetchSerp(query);
    if (page?.blocked) return null;
    return (page?.results || []).map((x) => ({ title: x.title, url: x.url }));
  } catch {
    return null;
  }
}