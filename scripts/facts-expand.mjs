#!/usr/bin/env node
// O4 facts 扩容 CLI（2026-11-18）：QA/官方 → LLM 抽取 → 分类 → 提案报告 → 可选写库。
//   node scripts/facts-expand.mjs                 # dry-run，候选默认=cited>0（控 LLM 成本）
//   node scripts/facts-expand.mjs --all           # 全量 QA（LLM 调用多，慎用）
//   node scripts/facts-expand.mjs --items x.json  # 指定候选
//   node scripts/facts-expand.mjs --apply         # 按提案写库（先看报告；改库前备份 facts 快照）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, argvOf, SKILL_ROOT } from './lib/paths.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { loadUsage } from './lib/usage.mjs';
import { openDb } from './lib/db.mjs';
import { initFacts, addFact, addSource, listFacts } from './lib/facts.mjs';
import { governFacts } from './lib/govern.mjs';
import { chat } from './lib/llm.mjs';
import { classifyExtractions, renderProposal } from './lib/facts-expand.mjs';

const { argOf, has } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
const db = openDb(config.paths.postDbFile);
initFacts(db);
const qa = await loadQaLibrary(config.paths.qaFile);
const usage = await loadUsage(config.paths.usageFile);
const existing = listFacts(db);

const SYS =
  '你是游戏知识结构化抽取器。判断给定问答是否包含「关于游戏内实体（植物/道具/关卡/活动/规则）的可枚举事实」。\n' +
  '判定标准（按顺序）：\n' +
  '1) 答案里若有「具体实体名 + 可枚举属性」（稀有度/价格/数量/时间/概率/获取方式/规则/例外/机制）→ layer="fact"，' +
  '把这些属性写进 attrs。例：「瓷砖萝卜是稀有植物，从2888传奇宝箱十连出」→ attrs={"稀有度":"稀有","获取方式":"2888钻石传奇宝箱十连"}。\n' +
  '2) 若含活动截止/限时/本期有效 → layer="activity"，attrs 照写，另给 validUntilDays。\n' +
  '3) 只有主观评价、没有可枚举属性（「值不值得」「好不好用」且答案无具体数据）→ layer="qa"。\n' +
  '4) 纯闲聊 → layer="talk"。\n' +
  '输出 JSON：{"layer":"fact|activity|qa|talk","entity":"规范实体名","type":"plant|item|level|event|rule",' +
  '"attrs":{},"aliases":[],"confidence":0-100,"validUntilDays":数字或null}。\n' +
  'attrs 只放**原文可直接读出**的键值，不猜测补全；即使内容像攻略，只要含具体数值/规则/例外也要抽成 fact。';

function pickCandidates() {
  const itemsFile = argOf('items', '');
  if (itemsFile) {
    const raw = JSON.parse(readFileSync(itemsFile, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.items || [];
    return arr.map((x) => ({
      question: x.question || x.text || '',
      answer: x.answer || '',
      source: x.source || 'manual',
      url: x.url || null,
    }));
  }
  const rows = qa.map((e) => ({
    question: e.question,
    answer: e.answer,
    source: e.source || null,
    url: e.source && /^https?:/.test(String(e.source)) ? e.source : null,
    cited: Number(usage.items?.[e.id]?.cited || 0),
  }));
  return has('all') ? rows : rows.filter((r) => r.cited > 0);
}

const cands = pickCandidates();
console.log(`[facts-expand] 候选 ${cands.length} 条 ｜ apply=${has('apply')}`);

// 确定性导入通道：--proposal <json> 直接用已审定的 applyList 入库（不重新抽取，避免 LLM 波动）
const proposalFile = argOf('proposal', '');
if (proposalFile) {
  const p = JSON.parse(readFileSync(proposalFile, 'utf8'));
  const applyList = Array.isArray(p) ? p : p.applyList || [];
  console.log(`[facts-expand] 从提案导入 ${applyList.length} 条（跳过 LLM 抽取）`);
  if (!has('apply')) {
    console.log('[facts-expand] 未加 --apply，只预览：');
    for (const a of applyList) console.log(`  ${a.name} ${JSON.stringify(a.attrs)} conf=${a.confidence}`);
    process.exit(0);
  }
  if (!applyList.length) {
    console.log('[facts-expand] 提案为空，未改库');
    process.exit(0);
  }
  const d0 = new Date();
  const p2b = (n) => String(n).padStart(2, '0');
  const ymd0 = `${d0.getFullYear()}-${p2b(d0.getMonth() + 1)}-${p2b(d0.getDate())}`;
  const snap = resolve(SKILL_ROOT, 'data', `facts-backup-${ymd0}.json`);
  writeFileSync(snap, JSON.stringify(listFacts(db), null, 2));
  let n = 0;
  for (const a of applyList) {
    const validUntil = a.validUntilDays ? Date.now() + a.validUntilDays * 86400000 : null;
    const id = addFact(db, {
      name: a.name, type: a.type || 'rule', attrs: a.attrs || {}, aliases: a.aliases || [],
      confidence: a.confidence ?? 95, source: a.source, validUntil,
      provenance: {
        source: a.source, confidence: a.confidence ?? 95,
        verifiedAt: a.official ? Date.now() : Date.now(), // 提案导入 = 已审定
        corroborations: 0,
      },
    });
    if (id) { addSource(db, id, { source: a.source || '确认', url: a.url, confidence: a.confidence ?? 95 }); n++; }
  }
  governFacts(db, { log: console.log });
  console.log(`[facts-expand] 已导入 ${n} 条；备份 → ${snap}`);
  console.log(`[facts-expand] 现有 facts ${listFacts(db).length} 条`);
  process.exit(0);
}

const results = [];
let failed = 0;
for (const c of cands) {
  let parsed = null;
  try {
    const r = await chat(config, {
      system: SYS,
      messages: [{ role: 'user', content: `问：${c.question}\n答：${String(c.answer || '').slice(0, 600)}` }],
      temperature: 0, maxTokens: 300, timeoutMs: 30000,
    });
    if (r.ok) parsed = JSON.parse(String(r.text).replace(/```json|```/g, '').trim());
  } catch {}
  if (!parsed || !parsed.layer) { failed++; continue; }
  results.push({ ...c, ...parsed });
}

const { applyList, uncertain, skipped } = classifyExtractions(results, { existing });
const report = renderProposal({ applyList, uncertain, skipped, failed, candidates: cands.length });
mkdirSync(config.paths.reportsDir, { recursive: true });
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const ymd = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const out = resolve(config.paths.reportsDir, `facts-proposal-${ymd}.md`);
writeFileSync(out, report);
writeFileSync(resolve(config.paths.reportsDir, `facts-proposal-${ymd}.json`), JSON.stringify({ applyList, uncertain, skipped }, null, 2));
console.log(`[facts-expand] 可入库 ${applyList.length} / 待确认 ${uncertain.length} / 跳过 ${skipped.length} / 失败 ${failed}`);
console.log(`[facts-expand] 报告 → ${out}`);

if (has('apply')) {
  if (!applyList.length) {
    console.log('[facts-expand] 无可入库条目，未改库');
  } else {
    const snap = resolve(SKILL_ROOT, 'data', `facts-backup-${ymd}.json`);
    writeFileSync(snap, JSON.stringify(listFacts(db), null, 2));
    let n = 0;
    for (const a of applyList) {
      const validUntil = a.validUntilDays ? Date.now() + a.validUntilDays * 86400000 : null;
      const id = addFact(db, {
        name: a.name, type: a.type, attrs: a.attrs, aliases: a.aliases,
        confidence: a.confidence, source: a.source, validUntil,
        provenance: {
          source: a.source, confidence: a.confidence,
          verifiedAt: a.official ? Date.now() : null, corroborations: 0,
        },
      });
      if (id) { addSource(db, id, { source: a.source || 'qa', url: a.url, confidence: a.confidence }); n++; }
    }
    governFacts(db, { log: console.log });
    console.log(`[facts-expand] 已入库 ${n} 条；备份 → ${snap}`);
  }
}