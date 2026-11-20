// 玩家负反馈检测（2026-11-17）：判断玩家回复是否反对/否定我们给出的结论。
import { chat } from './llm.mjs';

export async function detectOpposition(commentText, ourAnswer, { config = {}, log = () => {} } = {}) {
  const t = String(commentText || '').trim();
  if (!t) return false;
  const r = await chat(config, {
    system: '判断玩家回复是否反对/否定/指出我们结论的错误（含"不对/错了/不是/过时/早就改了"等）。单纯追问或补充不算反对。只输出 yes 或 no。',
    messages: [{ role: 'user', content: `我们的结论：${String(ourAnswer || '').slice(0, 200)}\n玩家回复：${t.slice(0, 200)}\n是否反对/否定我们的结论？只答 yes/no。` }],
    temperature: 0, maxTokens: 10, timeoutMs: 20000, log,
  });
  return r.ok && /yes|是/i.test(String(r.text || '').trim());
}