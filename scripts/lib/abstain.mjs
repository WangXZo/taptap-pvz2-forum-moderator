// 弃答归类（2026-11-18 大哥决策「两者都做」）：
//   C7 judge 拒（或低置信弃答）时——
//     真提问 → STATUS.MANUAL（版主「需人工」清单可见，可自己回；不再无声消失）
//     非提问 → STATUS.NO_NEED（无需回复）
//   两种情况都进 eval 候选（data/eval-candidates.jsonl），供后续补知识自动解决。
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILL_ROOT } from './paths.mjs';
import { STATUS } from './state.mjs';

export const ABSTAIN_REASON = 'abstain_low_conf';

/** 纯函数（便于测试）：弃答帖该落哪个状态。 */
export function classifyAbstain({ looksQ = false } = {}) {
  return {
    status: looksQ ? STATUS.MANUAL : STATUS.NO_NEED,
    reason: ABSTAIN_REASON,
    needsHuman: Boolean(looksQ),
  };
}

function candFile(config) {
  const dir = config?.paths?.dataDir
    ? String(config.paths.dataDir).replace(/\{\{SKILL\}\}/g, SKILL_ROOT)
    : resolve(SKILL_ROOT, 'data');
  return resolve(dir, 'eval-candidates.jsonl');
}

/**
 * 记一条评测候选（去重：同 postId 只留一条）。
 * @returns {boolean} 是否新写入
 */
export function appendEvalCandidate(config, { postId, title, text, reason, tier, entryId, intent } = {}) {
  if (config?.evalCandidates?.enabled === false) return false;
  if (!postId) return false;
  const file = candFile(config);
  try {
    mkdirSync(resolve(file, '..'), { recursive: true });
    // 去重：已有同 postId 就跳过（文件小，直接读；量大时再换索引）
    if (existsSync(file)) {
      const seen = readFileSync(file, 'utf8');
      if (seen.includes(`"postId":"${postId}"`)) return false;
    }
    const row = {
      ts: new Date().toISOString(),
      postId: String(postId),
      title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      reason: reason || ABSTAIN_REASON,
      tier: tier || null,
      entryId: entryId || null,
      intent: intent || null,
    };
    appendFileSync(file, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false; // 候选记录失败绝不影响主流程
  }
}