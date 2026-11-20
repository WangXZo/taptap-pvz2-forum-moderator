// O4 facts 扩容核心（2026-11-18）：抽取结果 → 分三类（可入库 / 待确认 / 跳过）+ 提案报告渲染。
// 抽成纯函数便于离线测试；LLM 抽取由 scripts/facts-expand.mjs 负责（CLI）。
import { renderGovernReport } from './qa-govern.mjs';
import { containment } from './qa-dedup.mjs';

const normName = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

/** 判断是否同一实体：归一化相等，或名字包含度足够高。
 *  实测：「植物阶数攻防」vs「植物阶级攻防成长规则」containment≈0.44（差"数/级"一字），
 *  而「无尽挑战」vs「摇滚无尽」≈0.11（确是不同实体）。阈值取 0.4 能区分这两类。 */
export function sameEntity(a, b, { threshold = 0.4 } = {}) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return containment(a, b) >= threshold;
}

/**
 * @param {Array} results 每条 {question, answer, source, url, layer, entity, type, attrs, aliases, confidence, official, validUntilDays}
 * @param {object} o
 * @param {Array} o.existing 现有 facts
 * @param {number} [o.minCommunityConfidence=70] 社区源最低置信（低于则留 QA 层）
 * @param {boolean} [o.trustOfficial=true] 官方源直接 95、不问
 * @returns {{applyList:Array, uncertain:Array, skipped:Array}}
 */
export function classifyExtractions(results = [], { existing = [], minCommunityConfidence = 70, trustOfficial = true } = {}) {
  const applyList = [];
  const uncertain = [];
  const skipped = [];
  for (const r of results) {
    if (!r) continue;
    if (r.layer !== 'fact' && r.layer !== 'activity') {
      skipped.push({ ...r, why: r.layer ? `layer=${r.layer}（非事实）` : '未抽取到 layer' });
      continue;
    }
    const name = String(r.entity || '').trim();
    if (!name) {
      uncertain.push({ ...r, why: '无实体名' });
      continue;
    }
    const attrs = r.attrs && typeof r.attrs === 'object' ? r.attrs : {};
    if (!Object.keys(attrs).length) {
      uncertain.push({ ...r, why: 'attrs 为空（无法结构化）' });
      continue;
    }
    const same = (existing || []).find((f) => f.name === name);
    if (same && JSON.stringify(same.attrs || {}) !== JSON.stringify(attrs)) {
      uncertain.push({ ...r, why: `与现有 fact 冲突（现 attrs=${JSON.stringify(same.attrs)}）` });
      continue;
    }
    if (same) {
      skipped.push({ ...r, why: '与现有 fact 完全一致（无需重复）' });
      continue;
    }
    // 🆕 2026-11-19：**近似同名也要拦** —— 实测抽出的「植物阶级攻防成长规则」与现有「植物阶数攻防」
    //   是同一实体，严格同名判定会放过去 → 造重复 fact。近似名一律进待确认（由用户决定合并或新建）。
    const near = (existing || []).find((f) => sameEntity(f.name, name));
    if (near) {
      uncertain.push({ ...r, why: `疑似与现有 fact 同实体「${near.name}」（现 attrs=${JSON.stringify(near.attrs)}）→ 确认合并或新建` });
      continue;
    }
    const conf = Number(r.confidence ?? 50);
    // ⚠️ 2026-11-19 教训：**不采信 LLM 单方面 official 标记** —— 实测它会把论坛社区帖也标 official=true
    //   → 直接升 95。官方判定只认**来源文本**（官方公告/官网域名），否则按社区源走置信闸。
    const srcText = String(r.source || '');
    // 官方源 / 人工核实（用户确认的知识）都算可信 → 95；其余按社区源走置信闸。
    const official = /官方|公告|official/i.test(srcText) || /hrgame\.com\.cn/i.test(srcText) || /用户确认|人工确认|人工核实/.test(srcText);
    if (!official && conf < minCommunityConfidence) {
      skipped.push({ ...r, why: `置信 ${conf}<${minCommunityConfidence} 且非官方 → 留 QA 层` });
      continue;
    }
    // attrs 值过泛（「抽取/有/是」这类无信息量词）→ 转待确认让用户补准。
    //   ⚠️ 不能用「长度≤2」判定：「稀有」「十连」这类 2 字值是有意义的。
    const VAGUE = /^(抽取|获取|有|是|无|没有|其他|未知|一般|可以|还行|不错|好用|相关)$/;
    const tooVague = Object.values(attrs).some((v) => typeof v === 'string' && VAGUE.test(v.trim()));
    if (tooVague) {
      uncertain.push({ ...r, why: `attrs 值过泛（${JSON.stringify(attrs)}）→ 需补准` });
      continue;
    }
    applyList.push({
      name,
      type: r.type || 'rule',
      attrs,
      aliases: Array.isArray(r.aliases) ? r.aliases : [],
      confidence: official && trustOfficial ? 95 : conf,
      official,
      source: r.source || null,
      url: r.url || null,
      validUntilDays: Number.isFinite(r.validUntilDays) ? Number(r.validUntilDays) : null,
      question: r.question,
    });
  }
  return { applyList, uncertain, skipped };
}

/** 提案报告（Markdown） */
export function renderProposal({ applyList = [], uncertain = [], skipped = [], failed = 0, candidates = 0, date = new Date() } = {}) {
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
  const L = [];
  L.push(`# facts 扩容提案 ${ymd}`);
  L.push('');
  L.push(`> 候选 ${candidates} ／ 可入库 ${applyList.length} ／ 待确认 ${uncertain.length} ／ 跳过 ${skipped.length} ／ 抽取失败 ${failed}`);
  L.push('');
  if (applyList.length) {
    L.push('## 可入库（官方或置信达标）');
    L.push('');
    L.push('| 实体 | 类型 | attrs | 置信 | 时效 |');
    L.push('|---|---|---|---|---|');
    for (const a of applyList) {
      L.push(`| ${a.name} | ${a.type} | ${JSON.stringify(a.attrs)} | ${a.confidence}${a.official ? '(官方)' : ''} | ${a.validUntilDays ? a.validUntilDays + ' 天' : '长期'} |`);
    }
    L.push('');
  }
  if (uncertain.length) {
    L.push('## 待大哥确认（不入库）');
    L.push('');
    for (const u of uncertain) {
      L.push(`- 《${String(u.question || '').slice(0, 34)}》→ 实体「${u.entity || '?'}」：[${u.why}] attrs=${JSON.stringify(u.attrs || {})}`);
    }
    L.push('');
  }
  if (skipped.length) {
    L.push('## 跳过');
    L.push('');
    for (const s of skipped) L.push(`- 《${String(s.question || '').slice(0, 34)}》：${s.why}`);
    L.push('');
  }
  if (!applyList.length && !uncertain.length && !skipped.length) L.push('_无候选_');
  return L.join('\n');
}