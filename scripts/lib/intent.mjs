// C5 意图分流 + query 改写（2026-11-17 P1）：规则为主（零成本），别名展开提升召回。
import { looksLikeQuestion, looksLikeShare, looksLikeEmotion } from './qa.mjs';
import { looksLikeCodeAsk } from './code-guard.mjs';
import { detectFriendRequest } from './mod-task.mjs';
import { listFacts } from './facts.mjs';

export function intentOf(post = {}) {
  const text = `${post.title || ''} ${post.text || ''}`;
  if (looksLikeCodeAsk(text) || detectFriendRequest({ title: post.title, text: post.text })?.hit) return 'code';
  // 问句里的「十连」是问规则（688是单抽还是十连）→ 不算庆祝；图片庆祝证据优先
  const asking = looksLikeQuestion(text);
  if (post.imageCelebrate || /(抽到|出了|欧皇|炫耀|终于有了)/.test(text) || (/十连/.test(text) && !asking)) return 'celebrate';
  if (looksLikeEmotion(text)) return 'comfort';
  // 🆕2026-11-19（B4-8 实测）：**带疑问语气的判 qa，不算 share**。
  //   实测 bug：「这玩意儿就没法儿批量兑换吗？」被判 share（looksLikeShare 的弱特征命中「没」类），
  //   而它明显在提问。判成 share → 会去凑热闹而不是答疑 → 漏答（比误答更伤）。
  if (!Q_WORDS.test(text) && looksLikeShare(text)) return 'share';
  // 图片模板实体也算游戏相关（C8：图里是游戏内容，文本可能只有「看图/这是啥」）
  const gamey = GAME_VOCAB.test(text) || (post.imageEntities || []).length > 0;
  // 非游戏又非问句 → 闲聊（须在 looksLikeQuestion 前：它的「模糊默认提问」是 collect 标记口径，不该漏进 intent）
  if (!gamey && !ASK_WORDS.test(text)) return 'chat';
  if (looksLikeQuestion(text)) return 'qa';
  // 游戏相关但被 NOT_ASK（如「求攻略」含攻略）或无疑问词 → 仍走答疑通道（宁多答不漏答）
  if (gamey) return 'qa';
  return 'chat';
}

const GAME_VOCAB = /植物|僵尸|关卡|困难|无尽|钻石|钻|宝箱|十连|单抽|许愿|阵容|阶|挂件|萝卜|豌豆|向日葵|活动|码|游戏|pvz/i;
const ASK_WORDS = /什么|怎么|怎样|如何|为什么|哪个|多少|能不能|有没有|值得|推荐|求助|请问|吗|呢|？|\?/;
/** 明确疑问语气（share 判定要让位给 qa） */
const Q_WORDS = /吗|呢|怎么|如何|为什么|能不能|可不可以|有没有|多少|哪些|哪个|？|\?/;

/** query 改写：事实别名→规范名（提升 BM25/dense 召回）+ 去表情标记。规则零成本。 */
export function rewriteQuery(post = {}, { db } = {}) {
  let q = `${post.title || ''} ${post.text || ''} ${post.imageText || ''}`.replace(/\[表情_[^\]]+\]/g, ' ').trim();
  if (db) {
    for (const f of listFacts(db, { status: 'active' })) {
      for (const a of f.aliases || []) {
        if (a && q.includes(a)) q = q.split(a).join(`${a} ${f.name}`);
      }
    }
  }
  return q;
}