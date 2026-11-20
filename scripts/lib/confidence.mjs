// 动态置信度校准（2026-11-17，用户规格）：置信度随证据动态自调整。
// 档位：官方资料/人工核实=95；多渠道(>=2)一致=70；>3渠道且多玩家(>=3)统一=80；单一社区=50；
//       玩家负反馈(未解决)→先降(30)+needs_reverify；重新核实确认后→按证据重置。
// 判断依据：官方资料 / 多渠道核实 / 多玩家确认 / 玩家负反馈。
import { sourcesOf, feedbackStats, setFactStatus, addFeedback, calibratedConfidence } from './facts.mjs';

/** 委托 facts 的动态校准（单一实现，避免循环引用） */
export function calibrate(db, fact) {
  return calibratedConfidence(db, fact);
}

/** 记录负反馈：先降置信 + 标记 needs_reverify */
export function recordNegative(db, factId, { player, postId, reason } = {}) {
  addFeedback(db, factId, { type: 'negative', player, postId, reason });
  setFactStatus(db, factId, 'needs_reverify');
}

/** 记录玩家确认（多玩家统一） */
export function recordConfirm(db, factId, { player, postId } = {}) {
  addFeedback(db, factId, { type: 'confirm', player, postId });
}

/** 重新核实（是否过时/更新）：确认后清负反馈→按证据重置置信；过时→expired */
export async function reverify(db, fact, { config = {}, log = () => {}, chat } = {}) {
  const fb = feedbackStats(db, fact.id);
  if (!fb.unresolvedNegative) return { outcome: 'no_negative', confidence: calibrate(db, fact) };
  let verdict = 'confirmed';
  if (chat) {
    const r = await chat(config, {
      system: '核实一条游戏知识是否过时或已被更新。结合常识判断。只输出 confirmed(仍有效)/outdated(已过时)/uncertain。',
      messages: [{ role: 'user', content: `知识：${fact.name} ${JSON.stringify(fact.attrs || {})}\n玩家反对理由：${fb.lastNegativeReason || '无'}\n是否仍有效？只答 confirmed/outdated/uncertain。` }],
      temperature: 0, maxTokens: 10, timeoutMs: 30000,
    });
    if (r.ok) verdict = String(r.text).trim().toLowerCase().includes('outdated') ? 'outdated' : (String(r.text).trim().toLowerCase().includes('confirmed') ? 'confirmed' : 'uncertain');
  }
  if (verdict === 'outdated') {
    setFactStatus(db, fact.id, 'expired');
    log(`  [置信] ${fact.name} 核实=过时 → expired`);
    return { outcome: 'outdated', confidence: 20 };
  }
  if (verdict === 'confirmed') {
    // 清负反馈（标记 resolved）→ 重置置信
    db.prepare("UPDATE fact_feedback SET resolved=1 WHERE factId=? AND type='negative'").run(fact.id);
    setFactStatus(db, fact.id, 'active');
    const c = calibrate(db, fact);
    log(`  [置信] ${fact.name} 核实=确认 → 重置 ${c}`);
    return { outcome: 'confirmed', confidence: c };
  }
  log(`  [置信] ${fact.name} 核实=uncertain → 保持降档`);
  return { outcome: 'uncertain', confidence: 30 };
}