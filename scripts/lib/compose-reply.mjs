// 回复生成（LLM，2026-11-04）
//
// 用户要求（同一动作的几条说明合起来看）：
//   ① 「回复可以自由回复（包含楼中楼）」—— 帖子本身 / 一级回复 / 楼中楼，任何节点都能回
//   ② 「模板仅作为参考资料，不要使用了，固定结构组合也不行，不要用了」—— **一个模板都不许用**
//   ③ 「需按照以上补充信息作为上下文。即：不可僵硬抽取资料、模板做答。」
//      —— 三层树状上下文（见 lib/thread-context.mjs），答疑库资料只当**参考材料**，
//         不许照抄、不许拼装
//
// 所以这个模块只做四件事：
//   1. 组提示词：人设 + 三层上下文 + 资料（可选）+ 任务 -> 交给 LLM
//   2. 把 LLM 的输出洗成**能直接发**的形态（单行、去引号、去 Markdown、控长度）
//   3. 过三道硬护栏：不许贬低玩家 / 不许替官方承诺 / 不许泄露内部信息
//   4. 选一个结尾表情（TapTap 表情只能点选或节点，见 references/emojis.md）
//
// 生成失败 → 明确返回 ok:false，由调用方**转人工**，绝不退回模板（用户明确禁止）。

import { chat } from './llm.mjs';
import { renderContext, contextForNode } from './thread-context.mjs';
import { assertKind } from './summon.mjs';
import { assertNoLeak } from './variants.mjs';
import { clampReply } from './limits.mjs';
import { loadEmojiMap } from './taptap-api.mjs';

/** 各任务类型的写法指引（不是模板，是"让模型知道自己在干嘛"） */
const TASK_BRIEF = {
  answer: '玩家在提问，你是来答疑的。能给准话就给，给不了就老实说这块你也不确定，别硬编。',
  praise: '有人给了有用的回答，你想夸他一句。夸人夸到点上（他具体说了啥），别空喊牛逼。',
  summon: '有人点名喊你（版主助手/小鲸鱼/大肥鱼等），你要应一声，再顺着他的话往下接。',
  share: '有人在分享进度/攻略，你想凑一句热闹。别评价具体数值，别提答疑库内容。',
  proactive: '你在巡楼，看到这楼有话说，主动插一句。自然、别像公告。',
  interact:
    '玩家回应了你 —— 你夸过他、他回过你的话、或他点名叫你。现在可以继续接一句：顺着他的话往下接，别重复你说过的话，别邀功；他要是问了具体问题，答不上来就实话说拿不准。',
  chat: '有人在闲聊/吐槽，你接一句，共情为主，别讲大道理。',
  refuse: '这涉及退款/封号/客服/账号交易等，不归你管。礼貌说明帮不上，指个正道，别承诺任何结果。',
};

/** 长度约束（楼中楼天然短，一级回复可以略长） */
function styleFor(level) {
  if (level >= 1) return '单行，不超过 60 字，不要换行';
  return '1~3 句，不超过 100 字，不要换行';
}

/** 系统提示词：人设 + 铁律 */
function systemPrompt(config) {
  const sig = String(config?.reply?.signature || '').trim();
  return [
    '你是 TapTap「植物大战僵尸2」论坛的版主助手，昵称「小鲸鱼」。',
    '性格：聪明、有点懒、嘴甜，偶尔损一句但不伤人；说话像老玩家在群里聊天，不像客服。',
    '',
    '铁律（违反任何一条都不合格）：',
    '1. 不许贬低、嘲讽、辱骂任何玩家，哪怕他问得很基础。',
    '2. 不许替官方表态或承诺：不承诺修复时间、不给补偿口径、不说"内部消息"、不说"保证"。',
    '3. 不许编造游戏数据（具体数值、版本号、关卡细节、掉率）。你拿不准就说拿不准。',
    '4. 不许暴露内部机制：不要提答疑库、脚本、机器人、接口、模型、WAF、配置这些词。',
    '5. 只输出要发出去的那句话本身：不加引号、不加"回复："前缀、不解释你为什么这么说。',
    '6. 不用固定的开场套话（"在的""来了来了""这个问题"这类），每句都像现想的。',
    sig ? `7. 不要在正文里写签名（${sig}），系统会自动加在结尾。` : '',
    '',
    '你看到的是这栋楼的**三层结构**：帖子本身 → 一级回复 → 楼中楼。',
    '越往下越贴近当前话题；回复时要把**所有父级内容**都考虑进去，别答非所问。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 把 LLM 输出洗成能直接发的文本 */
function sanitize(raw, { maxChars }) {
  let t = String(raw || '').trim();
  // 去掉模型偶尔加的包装
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '');
  t = t.replace(/^(回复|答案|内容)\s*[:：]\s*/, '');
  t = t.replace(/^["'「『]+|["'」』]+$/g, '');
  // 多行压成单行（楼中楼 fill 不支持多行；接口虽支持但统一单行更好读）
  t = t.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // 去掉模型自带的签名（系统会加）
  t = t.replace(/[「『]?版主助手-小鲸鱼[」』]?/g, '').trim();
  // 去掉句尾悬空标点
  t = t.replace(/[，、；：,;:]+$/, '').trim();
  if (!t) return '';
  if ([...t].length > maxChars) {
    const cut = t.slice(0, maxChars);
    t = cut.replace(/[，、；：,;:。！？!?][^，、；：,;:。！？!?]*$/, '').trim() || cut;
  }
  return t;
}

/** 按情绪选 1 个结尾表情（表情名必须在 emoji-map 里） */
function pickEmoji(kind, text, config) {
  if (config?.reply?.emoji?.enabled === false) return null;
  const t = String(text || '');
  const pool = ['点赞', '比心', '开心', '可爱', '星星眼', '加油', '思考', '送花', '酷', '微笑'];
  let want;
  if (kind === 'praise') want = ['点赞', '星星眼', '比心', '酷'];
  else if (kind === 'celebrate') want = ['点赞', '星星眼', '大笑'];
  else if (kind === 'refuse') want = ['叹气', '不好意思', '祈祷'];
  else if (kind === 'chat') want = ['微笑', '狗头', '吃瓜'];
  else want = pool;
  const map = loadEmojiMap();
  const usable = want.filter((n) => map && Object.prototype.hasOwnProperty.call(map, n));
  const list = usable.length ? usable : want;
  // 用文本长度做个稳定的散列，避免同一句话每次换表情
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return list[h % list.length] || null;
}

/**
 * 把命中的答疑库条目**整理**成"参考资料"
 *
 * 用户原话：「如果命中的QA答疑资料，请将对应内容涉及的部分整理后，作为资料添加到上下文」
 *
 * 所以不是原样贴整段答案，而是：
 *   ① 按当前话题（这栋楼的标题/正文/父链/目标发言）跟答案里的句子做词面重合打分
 *   ② 每条只留**最相关的 1~2 句**，单句 ≤140 字
 *   ③ 去重（不同条目给出相同句子时只留一份）
 *   ④ 明确标注「参考资料，不许照抄」—— 模型负责用自己的话讲，不是搬运
 *
 * @returns {string} 整理好的资料块（没有命中就返回空串）
 */
export function condenseMaterial(qaHits = [], { query = '', maxEntries = 3 } = {}) {
  if (!Array.isArray(qaHits) || !qaHits.length) return '';
  const q = String(query || '');

  // 话题词：中文按 2-gram，英文按单词（够用，不引依赖）
  const grams = new Set();
  for (const m of q.matchAll(/[\u4e00-\u9fa5]{2}/g)) grams.add(m[0]);
  for (const m of q.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) grams.add(m[0].toLowerCase());

  const seen = new Set();
  const out = [];
  for (const h of qaHits.slice(0, maxEntries)) {
    const question = String(h?.question || '').replace(/\s+/g, ' ').trim();
    const answer = String(h?.answer || '').replace(/\s+/g, ' ').trim();
    if (!answer) continue;

    // 拆句（中英文句末标点都算），再按相关度排序
    const sents = answer
      .split(/(?<=[。！？!?；;])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4);
    const scored = sents.map((s, i) => {
      let hit = 0;
      for (const g of grams) if (s.includes(g)) hit++;
      return { s, i, hit, score: hit * 10 - i }; // 同分保留靠前的
    });
    scored.sort((a, b) => b.score - a.score);
    const pick = (scored.length ? scored : [{ s: answer, score: 0 }])
      .slice(0, 2)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.s)
      .join('');

    let body = pick.slice(0, 140);
    if (seen.has(body)) continue;
    seen.add(body);
    out.push(`- 【库】问：${question || '(无题)'}\n  相关要点：${body}`);
  }
  return out.join('\n');
}

/**
 * 生成一条回复
 *
 * @param {object} o
 * @param {object} o.config
 * @param {string} o.kind       answer | praise | summon | share | proactive | chat | refuse
 * @param {object} o.tree        buildThreadTree 结果（三级树）
 * @param {string} o.targetId    要回复的节点 id（`post:<id>` 或评论 id）
 * @param {Array}  [o.qaHits]    答疑库命中条目（只作参考材料）
 * @param {string} [o.hint]      额外要求（比如"这次别提阵容"）
 * @param {Function} [o.log]
 * @returns {Promise<{ok:boolean, text?:string, emoji?:string|null, reason?:string, channel?:string, model?:string}>}
 */
export async function composeReply({
  config = {},
  kind = 'answer',
  tree = null,
  targetId = '',
  qaHits = [],
  avoidTexts = [],
  hint = '',
  log = () => {},
} = {}) {
  if (!tree) return { ok: false, reason: 'no_tree' };
  const ctx = contextForNode(tree, targetId, { expandMentions: true });
  if (!ctx.target) return { ok: false, reason: 'no_target' };

  const level = ctx.level;
  const isRefuse = kind === 'refuse' || ctx.target.level === 0 ? kind === 'refuse' : false;
  const finalKind = isRefuse ? 'refuse' : kind;
  const maxChars = level >= 1 ? 70 : 130;

  // 资料：**先整理再注入**（只取与当前话题相关的句子，明确标注不许照抄）
  const topicForMatch = [
    ctx.target?.title || '',
    ctx.target?.text || '',
    ...ctx.chain.map((n) => `${n.title || ''} ${n.text || ''}`),
  ].join(' ');
  const material = condenseMaterial(qaHits, { query: topicForMatch });

  const userMsg = [
    '## 这栋楼的三层结构（帖子 → 回复 → 楼中楼，越往下越贴近当前话题）',
    renderContext(ctx),
    '',
    '## 你要回的是',
    ctx.target.level === 0
      ? '帖子本身（发一条一级回复）'
      : `【${ctx.target.level === 1 ? '回复' : '楼中楼'}#${ctx.target.id}】${ctx.target.author}：${ctx.target.text}`,
    '',
    `## 这次的任务`,
    TASK_BRIEF[finalKind] || TASK_BRIEF.answer,
    material
      ? `\n## 参考资料（已按本楼话题挑出相关部分，**仅供参考**：用自己的话讲，不许照抄、不许整段搬）\n${material}`
      : '',
    avoidTexts && avoidTexts.length
      ? `\n## 你最近说过的话（**别重复这些说法**，换个说法、换个角度）\n${avoidTexts
          .slice(-12)
          .map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').slice(0, 60)}`)
          .join('\n')}`
      : '',
    hint ? `\n## 额外要求\n${hint}` : '',
    '',
    `## 输出要求\n${styleFor(level)}。直接给出要发出去的那句话。`,
  ]
    .filter(Boolean)
    .join('\n');

  const r = await chat(config, {
    system: systemPrompt(config),
    messages: [{ role: 'user', content: userMsg }],
    temperature: Number(config?.llm?.temperature ?? 0.85),
    maxTokens: Number(config?.llm?.maxTokens ?? 600),
    log,
  });
  if (!r.ok) return { ok: false, reason: r.error || 'llm_failed', tried: r.tried };

  let text = sanitize(r.text, { maxChars });
  if (!text) return { ok: false, reason: 'empty_output', channel: r.channel, model: r.model };

  // 三道硬护栏（不合格就不发，不硬改）
  const kindChk = assertKind(text);
  if (!kindChk.ok) return { ok: false, reason: `guard:${kindChk.hit}`, text, channel: r.channel };
  const leakChk = assertNoLeak(text);
  if (!leakChk.ok) return { ok: false, reason: `leak:${leakChk.hit}`, text, channel: r.channel };

  // 长度兜底（含签名与表情）
  const emoji = pickEmoji(finalKind, text, config);
  const withSig = config?.reply?.signature
    ? `${text} ${config.reply.signature}${emoji ? `[表情_${emoji}]` : ''}`
    : `${text}${emoji ? `[表情_${emoji}]` : ''}`;
  const capped = clampReply(withSig, { signature: config?.reply?.signature || '' });

  return { ok: true, text: capped, body: text, emoji, channel: r.channel, model: r.model, level };
}
