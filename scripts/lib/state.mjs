// 状态库：累积记录每条帖子的处理状态（防重复回复）
//
// 键 = moment_id（19 位十进制字符串，禁止转数字，会丢精度）
//
// 四类标记：
//   pending   未回复待回复
//   replied   已回复
//   no_need   无需回复
//   manual    需人工处理

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const STATUS = {
  PENDING: 'pending',
  REPLIED: 'replied',
  NO_NEED: 'no_need',
  MANUAL: 'manual',
};

export const REASON = {
  ALREADY_REPLIED: 'already_replied',
  OTHERS_REPLIED: 'others_replied', // 社区已有他人回答 → 标记已回复，并把答案沉淀进答疑库
  NOT_QUESTION: 'not_question',
  DUPLICATE: 'duplicate',
  SENSITIVE: 'sensitive',
  LOW_CONFIDENCE: 'low_confidence',
  NO_QA_MATCH: 'no_qa_match',
  TOO_NEW: 'too_new',
  SEND_FAILED: 'send_failed',
  NO_INPUT: 'no_input',
  OVER_CAP: 'over_cap',
  LEAK: 'leak', // 回复含疑似内部内容 → 拒发，转人工
  OTHER: 'other',
};

export const LABEL = {
  [STATUS.PENDING]: '⏳ 未回复待回复',
  [STATUS.REPLIED]: '✅ 已回复',
  [STATUS.NO_NEED]: '➖ 无需回复',
  [STATUS.MANUAL]: '🖐 需人工处理',
};

export const REASON_LABEL = {
  [REASON.ALREADY_REPLIED]: '我已回复过',
  [REASON.OTHERS_REPLIED]: '他人已回复（已入库）',
  [REASON.NOT_QUESTION]: '非提问帖',
  [REASON.DUPLICATE]: '重复问题',
  [REASON.SENSITIVE]: '含敏感词',
  [REASON.LOW_CONFIDENCE]: '置信度不足',
  [REASON.NO_QA_MATCH]: '未命中答疑库',
  [REASON.TOO_NEW]: '新帖冷却中',
  [REASON.SEND_FAILED]: '发送失败',
  [REASON.NO_INPUT]: '找不到回复框',
  [REASON.OVER_CAP]: '超出单轮上限',
  [REASON.LEAK]: '含内部内容已拦截',
  [REASON.OTHER]: '其他',
};

// 旧版状态值 → 新版四类
const MIGRATE = {
  matched: [STATUS.PENDING, null],
  suggest: [STATUS.MANUAL, REASON.LOW_CONFIDENCE],
  no_match: [STATUS.MANUAL, REASON.NO_QA_MATCH],
  skipped: [STATUS.NO_NEED, REASON.NOT_QUESTION],
  failed: [STATUS.MANUAL, REASON.SEND_FAILED],
  new: [STATUS.MANUAL, REASON.OTHER],
};

export async function loadState(file) {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    const st = { version: 2, posts: {}, runs: [], ...j };
    const VALID = new Set(Object.values(STATUS));
    for (const [id, p] of Object.entries(st.posts)) {
      if (!VALID.has(p.status)) {
        const m = MIGRATE[p.status];
        st.posts[id] = { ...p, status: m ? m[0] : STATUS.MANUAL, reason: p.reason || (m ? m[1] : REASON.OTHER) };
      }
      if (!('normKey' in st.posts[id])) st.posts[id].normKey = normKey(st.posts[id].title || '');
    }
    st.version = 2;
    return st;
  } catch {
    return { version: 2, posts: {}, runs: [] };
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

export function hashText(s) {
  return createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
}

/** 归一化文本，用于「重复问题」判定 */
export function normKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 80);
}
