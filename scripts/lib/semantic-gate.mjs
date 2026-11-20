// 语义确认门（2026-11-17）：带「语义确认」标记的 QA 条目命中后，
// 先让 LLM 综合语义（帖子正文+图片识别内容）判断玩家是否真在问这条，确认才选用。
// 防止「见图/见相似词就笼统套用资料」（如把其他自选误当花盆挂件碎片自选）。
// LLM 不可用 → 不自动选用（转人工），绝不瞎套。
import { chat } from './llm.mjs';

export async function confirmSemantic(post, entry, { config = {}, log = () => {} } = {}) {
  const ctx = [post?.title, post?.text, post?.imageText].filter(Boolean).join('\n');
  const r = await chat(config, {
    system: '你判断玩家帖子是否真的在问某条资料的问题。综合语义理解，别只因出现相似词就 yes。只输出 yes 或 no。',
    messages: [
      {
        role: 'user',
        content:
          `玩家帖子：\n${ctx}\n\n候选资料问题：${entry?.question || ''}\n候选资料答案：${String(entry?.answer || '').slice(0, 300)}\n\n` +
          `玩家这帖是否真的在问这条资料的问题？只答 yes 或 no。`,
      },
    ],
    temperature: 0,
    maxTokens: 10,
    timeoutMs: 30000,
    log,
  });
  if (!r.ok) {
    log('  [语义门] LLM 不可用 → 不自动选用');
    return false;
  }
  const yes = /yes|是/i.test(String(r.text || '').trim());
  log(`  [语义门] 《${String(post?.title || '').slice(0, 16)}》×「${String(entry?.question || '').slice(0, 16)}」→ ${yes ? '选用' : '不选用'}`);
  return yes;
}