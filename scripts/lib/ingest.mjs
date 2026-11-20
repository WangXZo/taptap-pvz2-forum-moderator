// C11 增量知识摄入（2026-11-17 P1）：weekly/评论分析/沉淀/官方 等源 → LLM 抽取 → 自治治理 → facts/QA。
// 增量：调用方按时间游标/去重只喂新增项。每源带 provenance+auto-confidence。
import { addFact, addSource, initFacts } from './facts.mjs';
import { governFacts } from './govern.mjs';
import { chat } from './llm.mjs';

const SYS = '你是知识摄入抽取器。读一条内容，只输出JSON：{"layer":"fact|qa|talk","entity":"实体名或null","type":"plant|item|level|event|rule|null","attrs":{},"aliases":[],"confidence":0-100}。fact=可结构化实体事实；qa=问答攻略；talk=话术。官方/公告来源 confidence 给 95。';

/** items: [{text, source, url}] → 摄入 facts（qa/talk 留给问答层沉淀管道）。返回统计。 */
export async function ingest(items, { config = {}, db, log = () => {} } = {}) {
  initFacts(db);
  const stat = { fact: 0, qa: 0, talk: 0, fail: 0 };
  const list = items || [];
  // LLM 关闭时**不发请求**（2026-11-20）：
  //   以前不检查这个开关，即使 llm.enabled=false 也会逐条去撞渠道、白等超时。
  //   在无凭据环境下还会留下未收尾的请求，进程退出时触发 libuv 断言（实测 test-ingest-sources 100% 崩）。
  if (config?.llm?.enabled === false) {
    stat.fail = list.length;
    governFacts(db, { log });
    return stat;
  }
  for (const it of list) {
    let r = null;
    try {
      const resp = await chat(config, { system: SYS, messages: [{ role: 'user', content: String(it.text || '').slice(0, 800) }], temperature: 0, maxTokens: 300, timeoutMs: 25000 });
      if (resp.ok) r = JSON.parse(String(resp.text).replace(/```json|```/g, '').trim());
    } catch {}
    if (!r || !r.layer) { stat.fail++; continue; }
    if (r.layer === 'fact' && r.entity) {
      const id = addFact(db, { name: r.entity, type: r.type || 'rule', attrs: r.attrs || {}, aliases: r.aliases || [], confidence: r.confidence ?? 50, source: it.source });
      if (id) addSource(db, id, { source: it.source, url: it.url, confidence: r.confidence ?? 50 });
      stat.fact++;
    } else stat[r.layer] = (stat[r.layer] || 0) + 1;
  }
  governFacts(db, { log });
  return stat;
}