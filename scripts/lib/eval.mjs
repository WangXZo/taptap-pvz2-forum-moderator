// C9 评测 harness（P3，2026-11-18）：bad-case 集 + 指标 + 回归/AB。轻量 JS，不引 RAGAS。
// 指标：routeAcc(意图路由) / skipAcc(该静默静默) / sourceAcc+recall@5(检索) / tierAcc(分档)
//       / tonePass(口吻+护栏规则扫) / faithPass(生成后忠实度 LLM-judge) / genOk。
// 规则模式零 LLM 成本；--llm 模式才跑 verify/compose/faith（控费：每 case 各一次）。
// overrides 可注入 retrieve/verify/compose/faith（离线测试用）。
import { intentOf } from './intent.mjs';
import { retrieve } from './retrieve.mjs';
import { verifyCandidate, checkFaithfulness } from './verify.mjs';
import { composeReply } from './compose-reply.mjs';
import { assembleMaterial } from './assemble.mjs';
import { buildThreadTree } from './thread-context.mjs';
import { assertKind } from './summon.mjs';
import { assertNoLeak } from './variants.mjs';
import { looksLikeCodeAsk } from './code-guard.mjs';

// AI 味/客服腔/公告腔词表（口吻规则扫；与 systemPrompt 口吻条款同源）
const AI_TONE = /总体来看|综上所述|建议您|亲爱的玩家|首先.*其次|前期.*后期|值得注意的是|作为一名|这个问题|总之|不容小觑|至关重要/;

/** 口吻+硬护栏规则扫（零 LLM）：AI 味词 + 贬低/承诺 + 泄露 */
export function toneScan(text) {
  const hits = [];
  const m = String(text || '').match(AI_TONE);
  if (m) hits.push(`AI味:${m[0]}`);
  const k = assertKind(String(text || ''));
  if (!k.ok) hits.push(`guard:${k.hit}`);
  const l = assertNoLeak(String(text || ''));
  if (!l.ok) hits.push(`leak:${l.hit}`);
  return { ok: hits.length === 0, hits };
}

const rate = (cases, key) => {
  const v = cases.map((c) => c[key]).filter((x) => x !== null && x !== undefined);
  return v.length ? Number((v.filter(Boolean).length / v.length).toFixed(3)) : null;
};

/**
 * 跑评测集。
 * @param {object} o {config, qa, db, set:[cases], llm, log, overrides}
 * @returns {{cases:Array, metrics:object}}
 */
export async function runEval({ config, qa, db, set, llm = false, log = () => {}, overrides = {} } = {}) {
  const retrieveImpl = overrides.retrieve || retrieve;
  const verifyImpl = overrides.verify || verifyCandidate;
  const composeImpl = overrides.compose || composeReply;
  const faithImpl = overrides.faith || checkFaithfulness;
  const cases = [];
  for (const c of set || []) {
    const post = {
      id: c.id, title: c.title, text: c.text || '',
      imageCelebrate: Boolean(c.imageCelebrate), imageEntities: c.imageEntities || [],
    };
    const row = { id: c.id, title: c.title };
    const intent = intentOf(post);
    row.intent = intent;
    row.routeOk = c.expect?.intent ? intent === c.expect.intent : null;
    if (c.expect?.skip) row.skipOk = intent === 'code' || looksLikeCodeAsk(`${post.title}\n${post.text}`);
    if (c.expect?.source || c.expect?.entryIncludes) {
      const r = await retrieveImpl(post, { qa, db, config, log });
      row.source = r.source;
      row.score = Number((r.score || 0).toFixed(3));
      row.entry = r.entry?.question || null;
      row.sourceOk = c.expect.source ? r.source === c.expect.source : null;
      row.recall5 = c.expect.entryIncludes
        ? (r.candidates || []).slice(0, 5).some((x) => String(x.question || '').includes(c.expect.entryIncludes))
        : null;
      if (llm && r.entry) {
        let rr = r;
        let v = await verifyImpl(post, rr.entry, { config, log });
        // 与 collect 同口径：fact 被 judge 拒 → 回退问答层重检+重判（别弃整帖）
        if (!v.ok && rr.source === 'fact') {
          const r2 = await retrieveImpl(post, { qa, db, config, log, skipFacts: true });
          if (r2.entry && r2.score >= (config?.match?.suggestScore ?? 0.45)) {
            const v2 = await verifyImpl(post, r2.entry, { config, log });
            if (v2.ok) { rr = r2; v = v2; }
          }
        }
        row.source = rr.source;
        row.entry = rr.entry?.question || null;
        if (c.expect.entryIncludes) row.recall5 = (rr.candidates || []).slice(0, 5).some((x) => String(x.question || '').includes(c.expect.entryIncludes));
        row.tier = v.tier;
        row.tierOk = c.expect.tier ? v.tier === c.expect.tier : null;
        const material = assembleMaterial({ entry: rr.entry, candidates: rr.candidates, db, config, query: `${post.title} ${post.text}` });
        const tree = buildThreadTree({ id: post.id, title: post.title, text: post.text, author: '玩家', authorId: '0' }, []);
        const gen = await composeImpl({ config, kind: 'answer', tree, targetId: tree.post.id, qaHits: [rr.entry], material, log });
        row.genOk = gen.ok;
        row.reply = gen.ok ? gen.text : null;
        if (gen.ok) {
          row.tone = toneScan(gen.text);
          row.toneOk = row.tone.ok;
          row.faithOk = await faithImpl(gen.text, material, { config, log });
        }
      }
    }
    cases.push(row);
  }
  const metrics = {
    n: cases.length,
    routeAcc: rate(cases, 'routeOk'),
    skipAcc: rate(cases, 'skipOk'),
    sourceAcc: rate(cases, 'sourceOk'),
    recall5: rate(cases, 'recall5'),
    tierAcc: rate(cases, 'tierOk'),
    genOk: rate(cases, 'genOk'),
    tonePass: rate(cases, 'toneOk'),
    faithPass: rate(cases, 'faithOk'),
  };
  return { cases, metrics };
}

/** P4-d：是否该跑每周评测（距上次 ≥ everyDays 天）。纯函数便于测试。 */
export function shouldRunWeekly(usage = {}, { everyDays = 7, now = new Date() } = {}) {
  if (usage?.evalWeekly === false) return false;
  const last = usage?.lastEvalAt ? Date.parse(usage.lastEvalAt) : 0;
  if (!last) return true; // 从未跑过
  return now.getTime() - last >= Number(everyDays) * 86400000;
}

/** 渲染 Markdown 报告 */
export function renderReport(res, { mode = 'rule', config } = {}) {
  const m = res.metrics;
  const lines = [
    `# C9 评测报告（${mode} 模式）`,
    '',
    `> ${new Date().toLocaleString('zh-CN')} ｜ pipeline=${config?.pipeline} ｜ dense=${config?.retrieve?.denseBackend} ｜ rerank=${config?.rerank?.backend}`,
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| case 数 | ${m.n} |`,
    `| 意图路由 routeAcc | ${m.routeAcc ?? '-'} |`,
    `| 静默正确 skipAcc | ${m.skipAcc ?? '-'} |`,
    `| 检索来源 sourceAcc | ${m.sourceAcc ?? '-'} |`,
    `| 召回@5 recall5 | ${m.recall5 ?? '-'} |`,
    `| 分档 tierAcc | ${m.tierAcc ?? '-'} |`,
    `| 生成成功 genOk | ${m.genOk ?? '-'} |`,
    `| 口吻+护栏 tonePass | ${m.tonePass ?? '-'} |`,
    `| 忠实度 faithPass | ${m.faithPass ?? '-'} |`,
    '',
    '## 逐 case',
    '',
    '| id | 意图 | 路由 | 来源 | 命中条目 | recall@5 | 分档 | 口吻 | 忠实 | 回复 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of res.cases) {
    const mark = (v) => (v === null || v === undefined ? '-' : v ? '✓' : '✗');
    lines.push(`| ${c.id} | ${c.intent} | ${mark(c.routeOk)} | ${c.source || '-'} | ${String(c.entry || '-').slice(0, 24)} | ${mark(c.recall5)} | ${c.tier || '-'} | ${mark(c.toneOk)} | ${mark(c.faithOk)} | ${String(c.reply || '').slice(0, 40)} |`);
  }
  const bad = res.cases.filter((c) => [c.routeOk, c.skipOk, c.sourceOk, c.recall5, c.tierOk, c.toneOk, c.faithOk].some((v) => v === false));
  if (bad.length) {
    lines.push('', '## 未达标 case（bad-case 回归入口）', '');
    for (const c of bad) lines.push(`- **${c.id}** 《${c.title}》：intent=${c.intent} source=${c.source || '-'} tier=${c.tier || '-'} tone=${JSON.stringify(c.tone?.hits || [])} reply=${c.reply || '-'}`);
  }
  return lines.join('\n');
}