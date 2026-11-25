// 答案拆要点（2026-11-25 多协作改造 P1）
//
// ## 为什么拆要点
//
// 大哥规格：「一个问题，回答应被拆为各个点分别评价，补充进回答」。
// 一段答案里往往混着好几件事：
//
//   「直接买神器保龄球；卡波就塔黄空吸到最高再点下一波」
//    ├─ 要点1：优先买神器保龄球
//    └─ 要点2：卡波建议空吸到最高
//
// 拆开之后才能：①每个点有**各自的置信度** ②多人对同一个问题可以各补各的点
// ③多来源对**同一个点**佐证时能聚合成更高置信度（而不是把整段当一个整体）。
//
// ## 拆的准则
//
//   · 一要点 = 一个**可独立评价**的具体说法
//   · 不拆成词/短语（那没法评价），也不拆成两段无关内容
//   · 数字、机制、结论要留在要点里（那是事实核验的对象）
//   · 拆不出来（本来就一句话）→ 就一个要点
//
// ## 置信度初判
//
// 不让模型自己给置信度（它总给高）。按来源给初判，口径与 summarize.mjs 一致：
//   人工条目（无 source）→ 95（人写过，兜底可信）
//   社区沉淀（有 source）→ 50（中置信度，玩家说法）
// 之后由多源聚合规则（lib/qa-entry.mjs 的 aggregateClaimConfidence）重算。

import { chat } from './llm.mjs';

const SPLIT_PROMPT = `把这段「玩家问答答案」拆成若干个**可独立评价的具体要点**。

要求：
- 每个要点是一个完整、可单独判断对错的说法（一句话）
- 不要拆成词语或短语；也不要把两件无关的事塞进同一点
- 数字、名称、机制必须原样保留，不要改写、不要补充
- 一共拆 1~6 条；本来就只有一句话时就只给 1 条
- 不要评价对错，不要加解释

只输出 JSON，不要任何说明：
{"claims":[{"text":"要点原文"},{"text":"..."}]}`;

/**
 * 拆分覆盖率校验
 *
 * 为什么要校验：LLM 拆点可能**漏内容**（丢掉半段）。要点是原文的切分，
 * 漏了就等于丢信息 —— 而答案会被自动发给玩家，丢信息比不拆更糟。
 *
 * 判据：要点拼起来的文本，其「字符集合」应覆盖原文的绝大多数字符。
 * 数字/标点/空格不算（模型可能改标点），只看实义字符。
 *
 * @returns {{ok:boolean, coverage:number}}
 */
export function checkCoverage(original, claims, { min = 0.9 } = {}) {
  const src = meaningfulChars(original);
  if (!src.size) return { ok: true, coverage: 1 };
  let covered = 0;
  for (const c of claims || []) {
    for (const ch of meaningfulChars(c.text)) if (src.has(ch)) covered++;
  }
  const coverage = covered / src.size;
  return { ok: coverage >= min, coverage };
}

/** 实义字符集合（去数字/标点/空白/常见连接字） */
function meaningfulChars(s) {
  const set = new Set();
  for (const ch of String(s || '')) {
    if (/[\s\p{P}\p{S}\d]/u.test(ch)) continue;
    set.add(ch);
  }
  return set;
}

/**
 * 把答案拆成要点
 * @param {object} o
 * @param {string} o.answer 答案正文
 * @param {string} [o.question] 问法（帮模型理解语境）
 * @param {object} [o.config] LLM 配置
 * @param {Function} [o.log]
 * @param {boolean} [o.strictCoverage=true] 覆盖率不达标就退回整段（防丢信息）
 * @returns {Promise<{claims:Array<{text:string,confidence:number}>, method:string}>}
 */
export async function splitClaims({ answer, question = '', config = {}, log = () => {}, strictCoverage = true } = {}) {
  const text = String(answer || '').trim();
  if (!text) return { claims: [], method: 'empty' };

  // 太短就不用费 LLM 了
  if (text.length < 12) {
    return { claims: [{ text, confidence: null }], method: 'trivial' };
  }

  let raw = '';
  try {
    const r = await chat(
      { ...config },
      {
        system: '你是知识拆解助手，只输出 JSON。',
        messages: [
          {
            role: 'user',
            // ⚠️ 格式要求必须写在 user 消息里：实测把格式只放 system，
            //    deepseek-v4.1-flash 这类会忽略它、改成输出自己的模板（question/key_points/…），
            //    结果解析不出 claims（2026-11-25 批量拆 102 条全挂）。
            content: [
              SPLIT_PROMPT,
              '',
              '---',
              `问：${question || '(未提供)'}`,
              '',
              '答：',
              text,
            ].join('\n'),
          },
        ],
        temperature: 0,
        maxTokens: 800,
        timeoutMs: 60000,
        log,
      }
    );
    raw = String(r?.text || '');
  } catch (e) {
    log(`  [拆要点] LLM 调用失败：${e.message} → 整段当一个要点`);
    return { claims: [{ text, confidence: null }], method: 'llm-failed' };
  }

  const parsed = parseJsonLoose(raw);
  // 宽容取要点列表：模型可能用 claims / key_points / points / items / 要点
  const list = pickClaimArray(parsed);
  const claims = [];
  for (const c of list) {
    const t = String(c?.text ?? c?.point ?? c ?? '').trim();
    if (!t) continue;
    claims.push({ text: t, confidence: null });
  }
  if (!claims.length) {
    log('  [拆要点] 模型没给出可用要点 → 整段当一个要点');
    return { claims: [{ text, confidence: null }], method: 'llm-empty' };
  }
  // 单点且与原文几乎一样 → 不折腾
  if (claims.length === 1 && normalize(claims[0].text) === normalize(text)) {
    return { claims: [{ text, confidence: null }], method: 'single' };
  }

  // 覆盖率闸：拆漏了不能要（宁可整段当一个要点，也不丢信息）
  if (strictCoverage) {
    const cov = checkCoverage(text, claims);
    if (!cov.ok) {
      log(`  [拆要点] 覆盖率 ${(cov.coverage * 100).toFixed(0)}% 不足 → 整段当一个要点`);
      return { claims: [{ text, confidence: null }], method: 'low-coverage' };
    }
    return { claims, method: 'llm', coverage: cov.coverage };
  }
  return { claims, method: 'llm' };
}

/** 宽容取要点数组：不同模型会换 key 名（实测 deepseek 给的是 key_points） */
function pickClaimArray(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  const KEYS = ['claims', 'key_points', 'keyPoints', 'points', 'items', '要点', 'answer_points'];
  for (const k of KEYS) {
    if (Array.isArray(parsed[k])) return parsed[k];
  }
  return [];
}

/** 宽松 JSON 解析（模型可能包围栏或加解释） */
function parseJsonLoose(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* 继续 */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续 */
    }
  }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(t.slice(s, e + 1));
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

function normalize(s) {
  return String(s || '').replace(/[\s\p{P}]+/gu, '').toLowerCase();
}

/**
 * 给要点定初判置信度（按来源性质，不问模型）
 * @param {Array} claims
 * @param {{source?:string, manual?:boolean}} o
 */
export function seedClaimConfidence(claims, { source = null, manual = false } = {}) {
  const base = manual || !source ? 95 : 50;
  return (claims || []).map((c) => ({ ...c, confidence: c.confidence != null ? c.confidence : base }));
}
