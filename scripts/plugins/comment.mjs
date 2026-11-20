// 插件：comment（评论分析，P4-c，2026-11-19）
//
// 目的：从本轮已读评论里识别**玩家信号**，喂给自治链路：
//   · 反对/否定我们结论 → confidence.recordNegative（已有 feedback.detectOpposition 做单条判断，这里批量汇总）
//   · 补充/纠正信息 → 记为 eval 候选（`data/comment-analysis.jsonl`），供后续补知识
//
// 设计取舍：
//   · **不发任何内容**（只分析），所以 planBatch 恒返回 null；
//   · 不额外调接口（评论已在 results._comments 里）；
//   · LLM 只在开启时用（config.comment.useLlm），默认走规则（零成本）。
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILL_ROOT } from '../lib/paths.mjs';

const fileOf = (config) => resolve(String(config?.paths?.dataDir || resolve(SKILL_ROOT, 'data')).replace(/\{\{SKILL\}\}/g, SKILL_ROOT), 'comment-analysis.jsonl');

/** 规则判据（零成本）：玩家反对/纠错的常见说法 */
const OPPOSE = /不对|错了|不是这样|过时|早改了|已经改了|假的|胡说|你搞错|有误|不正确|误导/;
const SUPPLEMENT = /补充|还有个|另外|其实还|漏了|忘了说|顺便说|更正/;

/** 从评论树里抽文本（兼容接口结构） */
function textsOf(comments = []) {
  const out = [];
  for (const c of comments || []) {
    const t = String(c?.contents?.json?.[0]?.children?.[0]?.text || c?.__text || '').trim();
    if (t) out.push({ text: t, author: c?.author?.name || '', id: String(c?.id_str || '') });
    for (const ch of c?.child_posts || []) {
      const t2 = String(ch?.contents?.json?.[0]?.children?.[0]?.text || '').trim();
      if (t2) out.push({ text: t2, author: ch?.author?.name || '', id: String(ch?.id_str || '') });
    }
  }
  return out;
}

export default {
  id: 'comment',
  name: '评论分析',

  async planBatch(results = [], ctx = {}) {
    const { config = {}, log = () => {}, db = null } = ctx;
    if (config.comment?.enabled === false) return null;

    const rows = [];
    for (const r of results || []) {
      const comments = r._comments;
      if (!Array.isArray(comments) || !comments.length) continue;
      for (const c of textsOf(comments)) {
        if (OPPOSE.test(c.text)) rows.push({ ts: new Date().toISOString(), postId: String(r.id), kind: 'oppose', author: c.author, commentId: c.id, text: c.text.slice(0, 160) });
        else if (SUPPLEMENT.test(c.text)) rows.push({ ts: new Date().toISOString(), postId: String(r.id), kind: 'supplement', author: c.author, commentId: c.id, text: c.text.slice(0, 160) });
      }
    }
    if (!rows.length) return null;

    try {
      const f = fileOf(config);
      mkdirSync(resolve(f, '..'), { recursive: true });
      // 简单去重：同 postId+commentId 只记一次
      const seen = new Set();
      if (existsSync(f)) {
        for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
          try { const o = JSON.parse(line); seen.add(`${o.postId}|${o.commentId}`); } catch {}
        }
      }
      let n = 0;
      for (const row of rows) {
        const k = `${row.postId}|${row.commentId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        appendFileSync(f, JSON.stringify(row) + '\n');
        n++;
      }
      if (n) {
        const oppose = rows.filter((x) => x.kind === 'oppose').length;
        const supp = rows.filter((x) => x.kind === 'supplement').length;
        log(`  [评论分析] 记录 ${n} 条信号（反对 ${oppose} / 补充 ${supp}）→ data/comment-analysis.jsonl`);
      }
    } catch (e) {
      log(`  [评论分析] 写入失败（${e.message}）→ 跳过`);
    }
    // 只分析不发送
    return null;
  },
};