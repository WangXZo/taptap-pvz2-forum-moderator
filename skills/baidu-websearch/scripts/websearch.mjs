#!/usr/bin/env node
// 百度 AI 搜索（结果页 → 自动取签名 → SSE 生成答案）
//
// 为什么这么绕：
//   百度「AI 搜索」的接口 `chat-ws.baidu.com/baikan/conversation` 需要
//   `k_signature` / `k_timestamp` / `pmgr_token` 三个签名参数。
//   但这三个参数**不用手工获取** —— 普通结果页 HTML 里内嵌了一整条 `sseApi`：
//     "sseApi":"https://chat-ws.baidu.com/baikan/conversation?...&word=<你的查询>&..."
//   所以流程是：
//     ① GET 结果页（匿名、无凭据）→ 正则抠出 sseApi
//     ② 原样 POST 那个 sseApi → text/event-stream → 拼 `value` 分片 → 答案
//
// ⚠️ 不需要登录、不需要 cookie。用户实测：不带 cookie 也能出答案（而且更快）。
//
// ⚠️ sseApi 是**偶发**的：同一个查询词，两次抓结果页可能一次有、一次没有
//    （页面版本抖动，实测 1.0MB 页面有 / 699KB 页面没有）。所以降级链是：
//      ① 有 sseApi → 拿 AI 答案（首选）
//      ② 没 sseApi → 再抓一次结果页（重试 1 次，大概率能拿到）
//      ③ 还是没 → 返回整理好的普通结果页（标题 + 链接 + 页面片段）
//      ④ 结果页也没有内容 → 返回失败并说明原因（被风控 / HTTP 错 / 搜不到）
//
// 用法：
//   node websearch.mjs --q "问题"                # 自动：答案优先，退化到结果页
//   node websearch.mjs --q "问题" --mode page    # 只抓结果页（快，标题+链接+片段）
//   node websearch.mjs --q "问题" --mode answer  # 只调 SSE（需 --sse 传内嵌地址）
//   node websearch.mjs --q "问题" --json         # 机器可读
//   node websearch.mjs --q "问题" --dump raw.txt # 把 SSE 原始流落盘（调正则用）

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const Q = arg('q');
/** 只在**直接运行**时跑 CLI；被 import（当库用）时不校验参数、不退出 */
const IS_MAIN = Boolean(process.argv[1] && /websearch\.mjs$/.test(process.argv[1]));
if (IS_MAIN && !Q) {
  console.error(
    '用法：node websearch.mjs --q "问题" [--mode auto|answer|page] [--timeout 60] [--json] [--no-quota]'
  );
  process.exit(1);
}
const MODE = arg('mode', 'auto');
const TIMEOUT = Number(arg('timeout', 60)) * 1000;
const JSON_OUT = has('json');
const DUMP = arg('dump', '');
const NO_QUOTA = has('no-quota');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const log = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

/**
 * 等答案的软上限：一般 5~8s 出完，慢的时候十几秒。
 * 不设 8s 硬限制 —— 流式读取，到点也会保留已收到的部分。
 */
export const DEFAULT_TIMEOUT_MS = 60000;
/** 单轮（一次业务处理轮次）最多查几次 —— 公开服务，别高频打 */
export const MAX_QUERIES_PER_ROUND = 2;
/** 两次查询最小间隔 */
export const MIN_GAP_MS = 3000;
/** 同一个查询没拿到 sseApi 时，重抓结果页的间隔 */
const RETRY_GAP_MS = 1500;

// ---------- 单轮配额（进程内计数；业务方每轮开头调 resetRound()） ----------
const _quota = { used: 0 };
let _lastQueryAt = 0;

/** 每轮业务处理开始时调用一次，重置本轮查询计数 */
export function resetRound() {
  _quota.used = 0;
}
/** 本轮还剩几次查询额度 */
export function quotaLeft() {
  return Math.max(0, MAX_QUERIES_PER_ROUND - _quota.used);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeQuota() {
  if (_quota.used >= MAX_QUERIES_PER_ROUND) return false;
  const wait = _lastQueryAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  _quota.used += 1;
  _lastQueryAt = Date.now();
  return true;
}

// ---------- 工具 ----------
/** 宽松去标签：剥标签 + 解实体，避免残留 <div data-…> */
function stripHtml(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 判断一段文本值不值得当摘要片段用 */
function isGoodSnippet(t) {
  if (!t) return false;
  const zh = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (zh < 12) return false;
  if (/^https?:/.test(t)) return false;
  if (/\{|\}|data-|class=|function\(|var |=>/.test(t)) return false;
  return true;
}

// ---------- ① 结果页 ----------
/**
 * 抓百度结果页：拿标题+链接，顺便抠出内嵌的 sseApi
 * @returns {Promise<{status:number,bytes:number,ms:number,blocked:boolean,
 *   results:{title,url,abstract}[], snippets:string[], sseApi:string}>}
 */
export async function fetchSerp(q) {
  const t0 = Date.now();
  const url = `https://www.baidu.com/s?ie=utf-8&f=8&rsv_bp=1&ch=&tn=baidu&bar=&wd=${encodeURIComponent(q)}`;
  const r = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', accept: 'text/html' },
  });
  const html = await r.text();
  const ms = Date.now() - t0;
  const blocked = /百度安全验证|wappass|验证码|异常流量/.test(html);

  // 结果块（标题/链接）—— 摘要节点多为 JS 渲染，能抠到几条算几条
  const results = [];
  const blocks = html.split(/<div[^>]*class="result[^"]*"/).slice(1);
  for (const b of blocks) {
    const h = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!h) continue;
    const u = b.match(/href="(https?:\/\/[^"]+)"/);
    const title = stripHtml(h[1]).slice(0, 90);
    if (!title) continue;
    // 摘要：h3 之后的一小段里，找第一条像样的中文
    let abstract = '';
    const cut = b.indexOf('</h3>');
    const after = cut >= 0 ? b.slice(cut + 5, cut + 1600) : '';
    for (const seg of after.split(/<(?:div|span|p|em|a)[^>]*>/)) {
      const t = stripHtml(seg);
      if (isGoodSnippet(t)) {
        abstract = t.slice(0, 160);
        break;
      }
    }
    results.push({ title, url: u ? u[1] : '', abstract });
    if (results.length >= 15) break;
  }

  // 整页兜底片段（摘要难对齐到具体条目时，至少留几条可读文本）
  const snippets = [];
  const seen = new Set();
  for (const m of html.matchAll(/<(span|div|p|em)[^>]*>([^<>]{25,240})</g)) {
    const t = stripHtml(m[2]);
    if (!isGoodSnippet(t)) continue;
    const key = t.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push(t.slice(0, 140));
    if (snippets.length >= 6) break;
  }

  // 内嵌 sseApi（含签名）
  const m = html.match(/"sseApi":"(https:\/\/chat-ws\.baidu\.com\/baikan\/conversation\?[^"]+)"/);
  const sseApi = m ? m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/') : '';
  return { status: r.status, bytes: html.length, ms, blocked, results, snippets, sseApi };
}

// ---------- ② SSE ----------
/** 把 sseApi 地址原样 POST，拼 value 分片成答案 */
export async function fetchAnswer(sseApi, q, { timeoutMs = DEFAULT_TIMEOUT_MS, dump = '' } = {}) {
  const t0 = Date.now();
  const ac = new AbortController(); // 只在超时/罚停时用来断流；不再用 setTimeout 硬砍请求
  const body = {
    message: {
      inputMethod: 'chat_search',
      isRebuild: false,
      content: { query: q, qtype: 0 },
      searchInfo: {
        is_follow_up: '1',
        dqa_is_wenda: '1',
        categoryIDs: [3],
        baikan_is_high_time_demand: '1',
        srcid: '279',
        order: '1',
        tplname: 'wenda_generate',
        strategy: '',
        ori_lid: '',
        re_rank: '',
        lid: '12632136525691565672',
        qid: '12632136525691565672',
        viscate_qid: '',
      },
      source: 'ala_279',
      from: 'apage_dqa',
      dqaRewrite: {},
    },
  };
  let raw = '';
  let status = 0;
  // 流式累积：超时到点时**保留已经流出来的部分**（答案尾部的引用丢失可接受）
  const vals = [];
  const refs = [];
  let buf = '';
  let timedOut = false;
  let fetchErr = '';
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'value' && typeof v === 'string') vals.push(v);
      else if (k === 'url' && typeof v === 'string' && v.startsWith('http')) refs.push(v);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  const eatLine = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    try {
      walk(JSON.parse(s.slice(5).trim()));
    } catch {}
  };
  const eatChunk = (chunk) => {
    raw += chunk;
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() || ''; // 末尾可能是半行，留到下一块
    for (const line of parts) eatLine(line);
  };
  try {
    const r = await fetch(sseApi, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'accept-language': 'zh-CN,zh;q=0.9',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        origin: 'https://www.baidu.com',
        referer: 'https://www.baidu.com/',
        'user-agent': UA,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = r.status;
    if (!r.body) {
      eatChunk(await r.text());
    } else {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const left = deadline - Date.now();
        if (left <= 0) {
          timedOut = true;
          break;
        }
        const readP = reader.read();
        readP.catch(() => {}); // 超时 abort 后这次 read 会 reject，别留未处理
        const got = await Promise.race([readP, sleep(left).then(() => 'TIMEOUT')]);
        if (got === 'TIMEOUT') {
          timedOut = true;
          break;
        }
        if (got.done) break;
        eatChunk(dec.decode(got.value, { stream: true }));
      }
      eatChunk(dec.decode());
      if (buf.trim()) eatLine(buf);
      if (timedOut) {
        try {
          ac.abort();
        } catch {}
        try {
          await reader.cancel();
        } catch {}
      }
    }
  } catch (e) {
    // 连接断了 / 超时被 abort：已经吐出来的部分照用，不整段丢
    fetchErr = `${e.name}: ${e.message}`;
    timedOut = true;
  }

  if (dump) {
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(dump, raw, 'utf8');
    } catch {}
  }

  const answer = vals
    .join('')
    .replace(/\^\d+\^/g, '') // 百度自带的引用角标 ^22^
    .replace(/==/g, '') // 强调标记 ==xxx==
    .replace(/:ml-search\[(.*?)\]\{[^}]*\}/g, '$1') // 实体标记
    .replace(/:ml-intent\[(.*?)\]\{[^}]*\}/g, '$1') // 追问按钮
    .trim();
  const error = answer
    ? ''
    : fetchErr
      ? fetchErr
      : timedOut
        ? `等 ${timeoutMs / 1000}s 没出答案`
        : status !== 200
          ? `HTTP ${status}`
          : '答案为空';
  return {
    ok: Boolean(answer),
    status,
    answer,
    refs: [...new Set(refs)],
    bytes: raw.length,
    ms: Date.now() - t0,
    /** true = 到点了但已收到部分答案（当作可用，只是可能缺尾部引用） */
    partial: timedOut && Boolean(answer),
    error,
  };
}

// ---------- ③ 结果整理 ----------
/** 明显不是结果的东西（广告位/图片聚合/下载站导流） */
function isJunkTitle(t) {
  if (!t) return true;
  const zh = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (zh < 4) return true;
  if (/扫码下载|百度App|百度图片|视频大全|图片大全|极速下载|立即下载|正版下载|高速下载/.test(t)) return true;
  return false;
}

/** 链接太长（baidu.php 跳转）就截断显示 */
function shortUrl(u, max = 110) {
  if (!u) return '';
  const s = u.replace(/&amp;/g, '&');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 把结果页整理成一段可读文本（没拿到 AI 答案时用）
 * @param {{results:{title,url,abstract}[], snippets:string[]}} page
 */
export function buildPageText(q, page, { maxResults = 8, maxSnippets = 4 } = {}) {
  const lines = [];
  lines.push(`【百度搜索结果页】查询：${q}`);
  lines.push('（普通搜索结果整理，**不是** AI 生成答案，只算线索）');
  const rs = (page?.results || []).filter((r) => !isJunkTitle(r.title)).slice(0, maxResults);
  if (rs.length) {
    lines.push('');
    lines.push(`结果 ${rs.length} 条：`);
    rs.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      if (r.abstract) lines.push(`   ${r.abstract}`);
      if (r.url) lines.push(`   ${shortUrl(r.url)}`);
    });
  }
  const sn = (page?.snippets || []).filter(
    (s) => !rs.some((r) => r.abstract && r.abstract.includes(s.slice(0, 12)))
  );
  if (sn.length) {
    lines.push('');
    lines.push('页面片段：');
    for (const s of sn.slice(0, maxSnippets)) lines.push(`- ${s}`);
  }
  return lines.join('\n').trim();
}

/** 把 AI 答案整理成一段可读文本 */
export function buildAnswerText(q, ans, { maxRefs = 5 } = {}) {
  const lines = [`【百度 AI 搜索·生成答案】查询：${q}`, '', ans.answer || ''];
  const refs = (ans.refs || []).slice(0, maxRefs);
  if (refs.length) {
    lines.push('');
    lines.push('参考链接：');
    for (const u of refs) lines.push(`- ${u}`);
  }
  return lines.join('\n').trim();
}

// ---------- ④ 统一入口（业务方用这个） ----------
/**
 * 一次完整查询：答案优先 → 重抓一次 → 结果页 → 失败说明。
 *
 * @param {string} q
 * @param {object} [opts]
 * @param {'auto'|'answer'|'page'} [opts.mode='auto']
 * @param {number} [opts.timeoutMs=8000]   等 SSE 答案的时间
 * @param {boolean} [opts.useQuota=true]   是否占用单轮配额（默认占）
 * @param {string}  [opts.dump='']
 * @returns {Promise<{
 *   ok:boolean, mode:'answer'|'page'|'none',
 *   reason:''|'quota'|'blocked'|'http'|'error'|'empty',
 *   detail:string, text:string,
 *   answer:string, refs:string[], results:object[], snippets:string[],
 *   attempts:number, ms:number
 * }>}
 */
export async function search(q, opts = {}) {
  const { mode = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS, useQuota = true, dump = '' } = opts;
  const t0 = Date.now();
  const fail = (reason, detail, extra = {}) => ({
    ok: false,
    mode: 'none',
    reason,
    detail,
    text: '',
    answer: '',
    refs: [],
    results: [],
    snippets: [],
    attempts: 0,
    ms: Date.now() - t0,
    ...extra,
  });

  if (useQuota && !NO_QUOTA && !(await takeQuota())) {
    return fail('quota', `本轮查询额度已用完（单轮上限 ${MAX_QUERIES_PER_ROUND} 次）`);
  }

  // 只抓结果页
  if (mode === 'page') {
    let page;
    try {
      page = await fetchSerp(q);
    } catch (e) {
      return fail('error', `结果页请求失败：${e.message}`);
    }
    if (page.blocked) return fail('blocked', '结果页被百度风控（需要人工验证）', { attempts: 1 });
    if (page.status !== 200) return fail('http', `结果页 HTTP ${page.status}`, { attempts: 1 });
    if (!page.results.length && !page.snippets.length) {
      return fail('empty', '结果页正常，但没搜到结果', { attempts: 1 });
    }
    return {
      ok: true,
      mode: 'page',
      reason: '',
      detail: `拿到结果页：${page.results.length} 条结果`,
      text: buildPageText(q, page),
      answer: '',
      refs: [],
      results: page.results,
      snippets: page.snippets,
      attempts: 1,
      ms: Date.now() - t0,
    };
  }

  // 只调 SSE
  if (mode === 'answer') {
    const sseApi = opts.sseApi || '';
    if (!sseApi) return fail('error', 'mode=answer 需要传 sseApi');
    const ans = await fetchAnswer(sseApi, q, { timeoutMs, dump });
    if (!ans.ok) return fail('error', `SSE 没出答案：${ans.error || 'HTTP ' + ans.status}`, { attempts: 1 });
    return {
      ok: true,
      mode: 'answer',
      reason: '',
      detail: `AI 答案 ${ans.answer.length} 字`,
      text: buildAnswerText(q, ans),
      answer: ans.answer,
      refs: ans.refs,
      results: [],
      snippets: [],
      attempts: 1,
      ms: Date.now() - t0,
    };
  }

  // auto：答案优先，退化到结果页
  let page = null;
  let attempts = 0;
  let lastErr = '';
  let answerFail = '';

  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(RETRY_GAP_MS); // 只有没 sseApi 才重抓一次
    attempts += 1;
    try {
      page = await fetchSerp(q);
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    if (page.blocked) {
      return fail('blocked', '结果页被百度风控（需要人工验证）', { attempts });
    }
    if (page.status !== 200) {
      lastErr = `HTTP ${page.status}`;
      continue;
    }
    if (!page.sseApi) continue; // ← 偶发缺 sseApi，重抓一次

    const ans = await fetchAnswer(page.sseApi, q, { timeoutMs, dump });
    if (ans.ok) {
      return {
        ok: true,
        mode: 'answer',
        reason: '',
        detail: `AI 答案 ${ans.answer.length} 字｜引用 ${ans.refs.length} 条${
          ans.partial ? `（${timeoutMs / 1000}s 到点，尾部可能缺）` : ''
        }`,
        text: buildAnswerText(q, ans),
        answer: ans.answer,
        refs: ans.refs,
        results: page.results,
        snippets: page.snippets,
        attempts,
        ms: Date.now() - t0,
      };
    }
    answerFail = ans.error || `HTTP ${ans.status}｜答案为空`;
    break; // 签名有了但没答案 —— 重抓也没意义，退结果页
  }

  // 退：结果页
  if (page && page.results.length) {
    return {
      ok: true,
      mode: 'page',
      reason: '',
      detail: `没取到 AI 答案${answerFail ? `（${answerFail}）` : '（结果页没内嵌 sseApi）'}，退回结果页：${page.results.length} 条`,
      text: buildPageText(q, page),
      answer: '',
      refs: [],
      results: page.results,
      snippets: page.snippets,
      attempts,
      ms: Date.now() - t0,
    };
  }
  if (page && page.snippets.length) {
    return {
      ok: true,
      mode: 'page',
      reason: '',
      detail: `只剩页面片段：${page.snippets.length} 条`,
      text: buildPageText(q, page),
      answer: '',
      refs: [],
      results: [],
      snippets: page.snippets,
      attempts,
      ms: Date.now() - t0,
    };
  }
  if (lastErr) return fail('error', `抓结果页失败：${lastErr}`, { attempts });
  return fail('empty', '结果页正常，但没搜到结果（也可能没内嵌 sseApi）', { attempts });
}

// ---------- CLI（只在直接运行时执行） ----------
if (IS_MAIN && Q) {
  const out = { q: Q, mode: MODE, result: null };
  if (MODE === 'answer') {
    const sseApi = arg('sse', '');
    if (!sseApi) {
      console.error('mode=answer 需要 --sse 传内嵌地址；日常请用默认 auto');
      process.exit(1);
    }
    const ans = await fetchAnswer(sseApi, Q, { timeoutMs: TIMEOUT, dump: DUMP });
    out.result = {
      ok: ans.ok,
      mode: 'answer',
      reason: ans.ok ? '' : 'error',
      detail: ans.ok ? `AI 答案 ${ans.answer.length} 字` : `SSE 没出答案：${ans.error || 'HTTP ' + ans.status}`,
      text: ans.ok ? buildAnswerText(Q, ans) : '',
      answer: ans.answer || '',
      refs: ans.refs || [],
      results: [],
      snippets: [],
      attempts: 1,
      ms: ans.ms,
    };
  } else {
    out.result = await search(Q, { mode: MODE === 'page' ? 'page' : 'auto', timeoutMs: TIMEOUT, dump: DUMP });
  }
  const r = out.result;
  log(`[结果] ${r.ok ? '✅ 成功' : '❌ 失败'}｜模式=${r.mode}｜${r.detail}｜尝试 ${r.attempts} 次｜${r.ms}ms`);
  if (!JSON_OUT && r.text) log('\n' + r.text);
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  process.exit(r.ok ? 0 : 2);
}