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
import { confLabelOf } from './qa.mjs';
import { loadEmojiMap } from './taptap-api.mjs';
import { begin, phaseTrace } from './perf.mjs';

/** 各任务类型的写法指引（不是模板，是"让模型知道自己在干嘛"） */
const TASK_BRIEF = {
  answer: '玩家在提问，你是来答疑的老玩家。能给准话就用口语给，给不了就老实说这块你也没底，别硬编。答完可以顺带抛个轻话头（他那关/那植物啥情况），让他愿意接。',
  praise: '有人给了有用的回答，你想夸他一句。夸到点上（他具体说了啥），像玩家互夸，别空喊牛逼别写评语。',
  summon: '有人点名喊你（版主助手/小鲸鱼/大肥鱼等），应一声再顺着他的话接，像群里被@了回一句。',
  share: '有人在分享/晒进度或好东西，去凑一句热闹、接住他的兴奋，可以提他晒的具体东西（植物/关卡/运气），别讲攻略别评判数值对错，留个话头让他接。',
  celebrate: '他在庆祝/炫耀抽到稀有植物等好东西，替他高兴、夸他欧，接住兴奋，可提他晒的具体东西，留个轻话头（攒了多久钻？/下一个想抽啥？）。若提到688/2888钻那是稀有/传奇宝箱十连（已知），别问单抽还是十连。别讲攻略别扫兴别酸。',
  proactive: '你在巡楼，看到这楼有话说，主动插一句，自然像群聊插话，别像公告。',
  interact:
    '玩家回应了你 —— 你夸过他、他回过你的话、或他点名叫你。顺着他的话接一句，别重复别邀功；他问具体问题答不上就实话说没底。可以反问让他继续聊。',
  chat: '有人在闲聊/吐槽，你接一句，共情为主，像朋友搭话，别讲大道理别总结。',
  comfort:
    '他只是在发泄情绪（难受/可惜/被恶心到/白肝了），没有具体问题要你答。**陪着难受一下**：先认同这情绪正常，再说一句让人缓过来的话。别讲道理、别劝想开、别给攻略、别评价数值、别承诺处理、别查户口追问。',
  refuse: '这涉及退款/封号/客服/账号交易等，不归你管。礼貌说明帮不上，指个正道，别承诺任何结果。',
};

/** 长度约束（楼中楼天然短，一级回复可以略长） */
function styleFor(level) {
  if (level >= 1) return '一句口语，不超过 40 字，不要换行，像群聊回一句';
  return '1~2 句口语，不超过 70 字，不要换行，像群聊发消息，别写书面语';
}

/** 系统提示词：人设 + 铁律 */
function systemPrompt(config) {
  const sig = String(config?.reply?.signature || '').trim();
  return [
    '你是 TapTap「植物大战僵尸2」论坛的版主助手，昵称「小鲸鱼」，但说话就是个玩了很多年的老玩家。',
    '性格：聪明、有点懒、嘴甜，偶尔损一句但不伤人。',
    '',
    '口吻（最重要，违反就是 AI 味、不合格）：',
    '· 像玩家在群里聊天：短句、口语、可省主语、可用语气词（哈/嘿/哎/哇/牛逼/欧/绝了），别书面语。',
    '· 别写排比/对仗/总结腔/客服腔/公告腔（"前期…后期…""总体来看""建议您"一律不要）。',
    '· 玩家说话是碎的、跳的，别每句都完整主谓宾。',
    '· 保留互动性：适当留一个轻话头（反问/好奇/调侃）让玩家想回你；但别每句都问、别查户口。',
    '· 不确定就用玩家的方式带（"我印象里…""听说…你试试"），别写"二手信息/以实测为准/置信度"这种免责尾巴。',
    '',
    '对照（学左边，别学右边）：',
    '· 好："这关就是耗钻加运气，200钻就过了，你卡多久了？"  坏："该关卡难度较高，建议消耗钻石通过，总体容错率较低。"',
    '· 好："哇瓷砖萝卜！2888十连直接抱走，血赚啊，攒了多久钻？"  坏："恭喜您获得稀有植物，运气较好，值得庆祝。"',
    '· 好："蛇皮果挺值的，一阶就能用，有紫手套直接碾压鸭梨。"  坏："蛇皮果具有较高性价比，一阶即可使用，综合表现优于鸭梨。"',
    '',
    '铁律（违反任何一条都不合格）：',
    '1. 不许贬低、嘲讽、辱骂任何玩家，哪怕他问得很基础。',
    '2. 不许替官方表态或承诺：不承诺修复时间、不给补偿口径、不说"内部消息"、不说"保证"。',
    '3. 不许编造游戏数据（数值/版本号/关卡细节/掉率）。拿不准就用玩家口吻说没底，别硬编。',
    '3b. 参考资料带「置信度」标记=可信度：高(90+)直接给准话；中(60-90)用"大概/印象里"；低(<60)用"听说/你试试"。是口气不是模板，别照抄别加免责尾巴。',
    '    资料说法互相矛盾时，把矛盾点口语说出来，别替玩家挑一个当定论。',
    '3c. 资料有「基本公式+例外」的两段都照顾到，但用口语说，别写成条文。',
    '3d. 植物/关卡数值以官方图鉴（pvz2.hrgame.com.cn/books?type=10）为准；社区说法降档口语表述，别当官方数据讲。',
    '4. 不许暴露内部机制：不提答疑库/脚本/机器人/接口/模型/WAF/配置，也别 meta 叙述"我搜到/我查到"。',
    '5. 只输出要发出去的那句话本身：不加引号、不加"回复："前缀、不解释你为什么这么说。',
    '6. 不用固定的开场套话（"在的""来了来了""这个问题"这类），每句都像现想的。',
    sig ? `7. 不要在正文里写签名（${sig}），系统会自动加在结尾。` : '',
    '8. 签名由脚本统一追加，你**只写正文**。写一次签名会被当成正文重复发出去。',
    '9. 表情可以放在句中，也可以放在句尾。想用就写 `[表情_名字]`，**最多 1 个**，名字必须是标准表情组里的（不确定就别写，脚本会自己补一个）。',
    '',
    '你看到的是这栋楼的**三层结构**：帖子本身 → 一级回复 → 楼中楼。',
    '越往下越贴近当前话题；回复时要把**所有父级内容**都考虑进去，别答非所问。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 剥掉正文**开头**的 @提及（可能连续多个）
 *
 * 为什么（2026-11-20 大哥指出「@多次」）：
 *   以前提示词要求模型「文案开头用 @某某 称呼他」，发送层（collect / plugins/interact）**又拼一次**
 *   `@${mention}` → 实际发出去变成「@狐玖儿 @狐玖儿 图里10/10…」，同一个名字 @ 了两次。
 *   线上实测 4/4 条 interact 回复全是双 @（post_event 有据）。
 *
 * 约定：**@ 只由发送层加一次**，正文里不该出现开头的 @。句中的 @（引用别人的话）不动。
 */
export function stripLeadingMention(t) {
  let s = String(t ?? '');
  // 用户名可能含中文/emoji/括号（如「哲学家尼采（杯哲）」），所以不按 \w 限定字符集，
  // 只要求「@ 开头 + 后面到空白之前的一串」。连续多个一并剥掉。
  const re = /^[\s\u3000]*(?:[@＠][^@＠\s\u3000]{1,24}[\s\u3000]*)+/u;
  let guard = 0;
  while (guard++ < 8) {
    const next = s.replace(re, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/**
 * 断言：同一条文本里，对**同一个名字**的 @ 不超过 1 次
 * 不同名字各 @ 一次是合法的（「@A 和 @B 都说这关能过」），只有重复同一个名字才算 bug。
 * @returns {{ok:boolean, hit?:string, count?:number}}
 */
export function assertSingleMention(text, name) {
  const n = String(name || '').trim();
  if (!n) return { ok: true, count: 0 };
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const count = (String(text ?? '').match(new RegExp(`[@＠]\\s*${esc}`, 'gu')) || []).length;
  return count <= 1 ? { ok: true, count } : { ok: false, count, hit: `重复@${n}×${count}` };
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
  // 剥掉开头的 @提及（@ 由发送层统一加一次，2026-11-20 修 @双重）
  t = stripLeadingMention(t);
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

/**
 * 按情绪选 1 个结尾表情（表情名必须在 emoji-map 里）
 * @param {object|null} mapArg 注入的表情表；不给就用运行时采集的 data/emoji-map.json
 *        （注入是为了让测试不依赖采集产物 —— 发布仓库里没有 data/，靠采集文件会测不成）
 */
function pickEmoji(kind, text, config, mapArg = null) {
  if (config?.reply?.emoji?.enabled === false) return null;
  const t = String(text || '');
  const pool = ['点赞', '比心', '开心', '可爱', '星星眼', '加油', '思考', '送花', '酷', '微笑'];
  let want;
  if (kind === 'praise') want = ['点赞', '星星眼', '比心', '酷'];
  else if (kind === 'celebrate') want = ['点赞', '星星眼', '大笑'];
  else if (kind === 'refuse') want = ['叹气', '不好意思', '祈祷'];
  else if (kind === 'chat') want = ['微笑', '狗头', '吃瓜'];
  else if (kind === 'comfort') want = ['比心', '加油', '拥抱', '叹气', '祈祷', '星星眼'];
  else want = pool;
  const map = mapArg || loadEmojiMap();
  const usable = want.filter((n) => map && Object.prototype.hasOwnProperty.call(map, n));
  const list = usable.length ? usable : want;
  // 用文本长度做个稳定的散列，避免同一句话每次换表情
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return list[h % list.length] || null;
}

/**
 * 表情落位（**位置不限**，用户 2026-11-10：「表情位置不要求。可以放中间。」）
 *
 * · 模型自己写了 `[表情_xx]` → 原地保留（句中/句尾都行）；
 *   但 emoji-map 里没有的名字必须剔掉 —— 留着会让 UI 兜底插不进去、整条转人工。
 * · 模型没写 → 按情绪在结尾补一个（`pickEmoji`）。
 *
 * @param {object|null} mapArg 注入的表情表（不给就用运行时采集的那份）
 * @returns {{text:string, emoji:string|null, modelPut:boolean}}
 */
export function applyEmojiPlacement(text, { kind = 'answer', config = {}, map: mapArg = null } = {}) {
  const map = mapArg || loadEmojiMap() || {};
  const cleaned = String(text || '')
    .replace(/\[表情_([^\]]+)\]/g, (m, name) => (map[name] ? m : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
  const modelPut = /\[表情_[^\]]+\]/.test(cleaned);
  const emoji = modelPut ? null : pickEmoji(kind, cleaned, config, map);
  const out = `${cleaned}${emoji ? `[表情_${emoji}]` : ''}`;
  return { text: out, emoji, modelPut };
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
    // 置信度随资料一起给模型（用户 2026-11-06 五档）：带百分比 + 档位名，模型好按档说话
    const pct = h?.confidence != null ? Number(h.confidence) : 50;
    const conf = `${pct}%·${confLabelOf(pct)}`;
    out.push(`- 【库｜置信度${conf}】问：${question || '(无题)'}\n  相关要点：${body}`);
  }
  return out.join('\n');
}

/**
 * 资料库（qa/资料/）按需加载 + 匹配（2026-11-26）
 *
 * 为什么放在这里而不是让调用方传：
 *   调用点有多个（reply / post-admin / 插件），每个都加一遍参数容易漏。
 *   放在这里 = 所有组答自动带上资料，且带缓存不会反复读盘。
 *
 * 资料库和答疑库的分工：
 *   答疑库 = 「问 X → 答 Y」的现成答案（匹配到直接照答）
 *   资料库 = 机制/流程/规则的事实基础（当参考材料，模型自己组织话）
 */
let _docCache = null;
let _docCacheAt = 0;
let _docCacheDir = '';

async function getDocMaterials(dir) {
  const now = Date.now();
  if (_docCache && _docCacheDir === dir && now - _docCacheAt < 60000) return _docCache;
  const { loadMaterials } = await import('./qa-materials.mjs');
  const docs = await loadMaterials(dir);
  _docCache = docs;
  _docCacheAt = now;
  _docCacheDir = dir;
  return docs;
}

/** 测试用：清资料缓存 */
export function _resetDocMaterialsCache() {
  _docCache = null;
  _docCacheAt = 0;
  _docCacheDir = '';
}

/**
 * 把命中的资料整理成「参考资料」块
 * @returns {Promise<string>} 空字符串 = 没命中/没启用
 */
export async function buildDocMaterial(config = {}, query = '') {
  if (config?.qa?.materials?.enabled === false) return '';
  const qaFile = config?.paths?.qaFile;
  if (!qaFile) return '';
  try {
    const { dirname, join } = await import('node:path');
    const dir = config?.qa?.materials?.dir || join(dirname(qaFile), '资料');
    const docs = await getDocMaterials(dir);
    if (!docs.length) return '';
    const { matchMaterials, formatMaterials } = await import('./qa-materials.mjs');
    const hits = matchMaterials(query, docs, {
      topN: Number(config?.qa?.materials?.topN ?? 2),
      minScore: Number(config?.qa?.materials?.minScore ?? 8),
    });
    if (!hits.length) return '';
    return formatMaterials(hits, { maxCharsPerSection: Number(config?.qa?.materials?.maxCharsPerSection ?? 400) });
  } catch {
    return ''; // 资料读不了不影响组答
  }
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
  /** P2 C6：预组装的结构化资料块（v2）；给了就用它，不给走 condenseMaterial（v1） */
  material: materialOverride = null,
  avoidTexts = [],
  hint = '',
  /** 联网搜到的说法（答疑库没命中时补的，**二手信息**，按 50% 置信度讲） */
  webNote = '',
  log = () => {},
} = {}) {
  if (!tree) return { ok: false, reason: 'no_tree' };
  const ctx = contextForNode(tree, targetId, { expandMentions: true });
  if (!ctx.target) return { ok: false, reason: 'no_target' };

  const level = ctx.level;
  const isRefuse = kind === 'refuse' || ctx.target.level === 0 ? kind === 'refuse' : false;
  const finalKind = isRefuse ? 'refuse' : kind;
  // 字数上限走配置（2026-11-20）：以前写死 70/130，改一次要动代码还要重测。
  // 平台硬上限 1000（LIMITS.reply），这里只是「说短点」的软限制。
  const maxChars = (() => {
    const mc = config?.reply?.maxChars;
    const fallback = level >= 1 ? 70 : 130;
    if (!mc || typeof mc !== 'object') return fallback;
    const v = Number(level >= 1 ? mc.nested : mc.post);
    return v > 0 ? v : fallback;
  })();

  // 资料：**先整理再注入**（只取与当前话题相关的句子，明确标注不许照抄）
  const topicForMatch = [
    ctx.target?.title || '',
    ctx.target?.text || '',
    ...ctx.chain.map((n) => `${n.title || ''} ${n.text || ''}`),
  ].join(' ');
  const material = materialOverride != null ? materialOverride : condenseMaterial(qaHits, { query: topicForMatch });
  // 资料库（qa/资料/）：机制/流程/规则类事实，作为**参考材料**（不是答案）
  const docMaterial = await buildDocMaterial(config, topicForMatch);
  const materialAll = [material, docMaterial].filter(Boolean).join('\n');
  // 图片识别内容（S5，2026-11-16）：帖子文本里的 [图片内容] 是 OCR/看图来的二手信息，按 50% 置信度框定。
  const hasImageContent =
    /\[图片内容\]/.test(ctx.target?.text || '') || ctx.chain.some((n) => /\[图片内容\]/.test(n?.text || ''));

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
    materialAll
      ? `\n## 参考资料（已按本楼话题挑出相关部分，**仅供参考**：用自己的话讲，不许照抄、不许整段搬）\n${materialAll}`
      : '',
    webNote
      ? `\n## 听来的二手说法（不是官方口径，信任度按 50%）\n` +
        `用玩家口吻自然带出（「我听说…」「印象里…」），**别写「二手信息/以实测为准」这种书面免责尾巴，也别 meta 说「我搜到」**；` +
        `只讲这范围内的，不许补之外的数字/时间/细节，别当定论。\n\n` +
        `${String(webNote).slice(0, 1200)}`
      : '',
    hasImageContent
      ? `\n## 关于帖子里的「[图片内容]」\n那是从玩家截图里看来的，用口语自然带（「看图里是…」「图里好像是…」），只讲图里有的，别补图里没有的数字/时间，别写免责尾巴。\n`
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

  // 打点（T20）：组答通常是全链路最大的耗时项，先量再优化
  const __t0 = begin();
  const r = await chat(config, {
    system: systemPrompt(config),
    messages: [{ role: 'user', content: userMsg }],
    temperature: Number(config?.llm?.temperature ?? 0.85),
    maxTokens: Number(config?.llm?.maxTokens ?? 600),
    log,
  });
  phaseTrace(config, 'compose', __t0, { note: kind });
  if (!r.ok) return { ok: false, reason: r.error || 'llm_failed', tried: r.tried };

  let text = sanitize(r.text, { maxChars });
  if (!text) return { ok: false, reason: 'empty_output', channel: r.channel, model: r.model };

  // 三道硬护栏（不合格就不发，不硬改）
  const kindChk = assertKind(text);
  if (!kindChk.ok) return { ok: false, reason: `guard:${kindChk.hit}`, text, channel: r.channel };
  const leakChk = assertNoLeak(text);
  if (!leakChk.ok) return { ok: false, reason: `leak:${leakChk.hit}`, text, channel: r.channel };

  // 长度兜底（含表情）。
  //
  // 表情位置**不要求**在结尾（用户 2026-11-10：「表情位置不要求。可以放中间。」）：
  //   · 模型自己写了 `[表情_xx]` → 保留原位置（句中、句尾都行）；
  //     但 emoji-map 里没有的名字要剔掉 —— 留着会让 UI 兜底插不进去、整条转人工。
  //   · 模型没写 → 由脚本按情绪在结尾补一个。
  //
  // ⚠️ **签名不在这里加**（用户 2026-11-10：「LLM 就不带签名了，要不然重复」）：
  //    模型输出 = 纯正文（`sanitize` 还会把模型自己写的签名剥掉），
  //    签名统一由**发送层加一次**：
  //      · `replyOne`（replier.mjs）→ `clampReply(..., {signature})`
  //      · `replyToComment`（reply-nested.mjs）→ 同上
  //      · 手动发的 `api-write.mjs` → `withSignature()`
  //    `clampReply` 里那句 `!s.includes(sig)` 保证「已经有了就不再补」，所以两边都不会重复。
  const placement = applyEmojiPlacement(text, { kind: finalKind, config });
  const emoji = placement.emoji;
  const body = placement.text;
  const capped = clampReply(body, { signature: config?.reply?.signature || '' });

  return { ok: true, text: capped, body: text, emoji, channel: r.channel, model: r.model, level };
}
