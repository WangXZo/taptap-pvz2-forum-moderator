// C7 分档验证（P0-M5）+ P2 泛化（2026-11-17）：自治，人工仅必要兜底。
// 分档：高(>=70)直接答 / 中(>=50)降档口语 / 低(<50)或 judge 不达标 → 弃答。
// P2：relevance/faithfulness 拆分 judge + 缓存（控费：仅 top1+缓存）+ 生成后忠实度自检。
import { chat } from './llm.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { SKILL_ROOT } from './paths.mjs';

/** 纯函数分档（便于测试）：judgeOk=false 或低置信 → abstain。
 *  高>=70（多渠道核实/官方）→准话；中>=50（单一社区）→降档口语；低<50（负反馈/不可信）→弃答。 */
export function tierOf(confidence, judgeOk) {
  if (!judgeOk) return 'abstain';
  const c = Number(confidence ?? 0);
  if (c >= 70) return 'high';
  if (c >= 50) return 'mid';
  return 'abstain';
}

const hash = (s) => createHash('sha1').update(String(s)).digest('hex');
const defaultCacheFile = () => resolve(SKILL_ROOT, 'data/verify-cache.json');

function loadCache(file, ttlMs) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(j || {})) if (v && now - (v.at || 0) < ttlMs) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function saveCache(file, cache) {
  try {
    // LRU 上限（O11）：按 at 保留最新 500 条，防缓存文件无限膨胀
    const entries = Object.entries(cache || {}).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    const capped = Object.fromEntries(entries.slice(0, 500));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(capped));
  } catch {}
}

/** 检索后 top1 做 relevance+faithfulness judge（一次调用拆两个 aspect），结合置信分档；带缓存。
 *  O11（2026-11-18）：缓存键含 entry.status/confidence + material 指纹 —— 治理改状态、置信校准、
 *  组装材料变化都会立即失效（原键只含 ctx|id|answer，库改了 24h 内仍用旧判）。 */
export async function verifyCandidate(post, entry, { config = {}, log = () => {}, cacheFile = null, material = null } = {}) {
  const ctx = [post?.title, post?.text, post?.imageText].filter(Boolean).join('\n');
  const ans = String(entry?.answer || JSON.stringify(entry?.attrs || {}));
  const ttl = Number(config?.verify?.cacheTtlHours ?? 24) * 3600 * 1000;
  const file = cacheFile || defaultCacheFile();
  const stamp = `${entry?.status || ''}|${entry?.confidence ?? ''}`;
  const key = hash(`${ctx}|${entry?.id || ''}|${ans}|${stamp}|${material ? hash(String(material).slice(0, 1500)) : ''}`);
  const cache = loadCache(file, ttl);
  let judgeOk, rel, faith;
  if (cache[key]) {
    ({ judgeOk, rel, faith } = cache[key]);
    log(`  [验证] 「${String(entry?.question || entry?.name || '').slice(0, 16)}」缓存命中 judge=${judgeOk}`);
  } else {
    const r = await chat(config, {
      system: '判断候选资料是否真能回答玩家帖子(relevance)，且候选答案本身被资料支持(faithfulness)。只输出JSON {"relevance":"yes/no","faithfulness":"yes/no"}。',
      messages: [{ role: 'user', content: `玩家帖子：\n${ctx}\n候选问：${entry?.question || entry?.name || ''}\n候选答：${ans.slice(0, 300)}\n输出JSON。` }],
      temperature: 0, maxTokens: 30, timeoutMs: 30000, log,
    });
    rel = false; faith = false;
    if (r.ok) {
      const t = String(r.text || '').trim();
      try {
        const j = JSON.parse(t.replace(/```json|```/g, '').trim());
        rel = /yes|是/i.test(String(j.relevance || ''));
        faith = /yes|是/i.test(String(j.faithfulness || ''));
      } catch {
        // 兼容旧 yes/no 输出
        rel = /yes|是/i.test(t);
        faith = rel;
      }
    }
    cache[key] = { judgeOk, rel, faith, at: Date.now() };
    saveCache(file, cache);
  }
  // fact 且 attrs 非空：事实即资料，faithfulness 循环论证无意义 → 恒 true，只信 relevance。
  // 放在缓存读取之后：旧缓存里的 faith=false 也被纠正（免等 TTL）。
  if (entry?.source === 'fact' && entry?.attrs && Object.keys(entry.attrs).length) faith = true;
  judgeOk = rel && faith;
  const confidence = entry?.confidence ?? entry?.provenance?.confidence ?? 50;
  const tier = tierOf(confidence, judgeOk);
  log(`  [验证] 「${String(entry?.question || entry?.name || '').slice(0, 16)}」conf=${confidence} rel=${rel} faith=${faith} → ${tier}`);
  return { ok: tier !== 'abstain', tier, judgeOk, relevance: rel, faithfulness: faith, confidence };
}

/** 生成后忠实度自检（P2 C7，扩展现泄露自检）：回复事实内容须被参考资料支持。
 *  无资料 → 跳过(true)；LLM 判 no 或不可用 → false（不确定即弃答）。 */
export async function checkFaithfulness(answer, material, { config = {}, log = () => {} } = {}) {
  if (!material) return true;
  const r = await chat(config, {
    system: '判断回复里的事实性内容（数值/规则/结论）是否都能在参考资料中找到支持。口语陪衬/情绪/互动话头不算事实内容。只输出 yes 或 no。',
    messages: [{ role: 'user', content: `参考资料：\n${String(material).slice(0, 1500)}\n回复：${String(answer).slice(0, 200)}\n事实内容是否被支持？只答 yes/no。` }],
    temperature: 0, maxTokens: 10, timeoutMs: 30000, log,
  });
  const ok = r.ok && /yes|是/i.test(String(r.text || '').trim());
  if (!ok) log('  [验证] 生成后忠实度自检不达标 → 弃答转人工');
  return ok;
}