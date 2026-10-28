// 回复文案变体 + 泄露自检 + 分享帖轻互动
//
// 为什么要这个：
//  1) 同一份答案被重复发出去会很难看（论坛上一刷屏就是一模一样的段落）。
//     → 同一份答案配不同的「说法外壳」，并记录已经发过的文本，优先选没用过的。
//  2) 回复**只能来自答疑库**，不能把别的东西带出去（内部文档名、路径、系统信息…）。
//     → 发送前做一次泄露自检，命中就拒发转人工。
//
// 【口吻】所有"外壳"都必须**口语化、亲切**，不能是公文腔。
//  反面（第一版）：『关于这个问题：…』『一句话概括：…』『补充一下：…』 —— 像工作汇报。
//  正面（用户给的标杆）：「大佬，好肝啊！」「正常，玩到正版了，拓维正常操作。」
//  原则：**外壳不改变事实，只改变语气**；答疑库里的答案正文才是事实来源，一个字都不动。
//
// 【不要模板化】**玩家是会把版主所有回复翻一遍的。**
//  所以：① 每类模板池 ≥ 15 套（开头 16 / 收尾 16 / 分享 16+16 / 婉拒 8）；
//        ② 最近用过的开头和收尾**主动避开**（见 pickFresh）。
//  以后加模板，数量只能往上，别往下。测试里有下限断言。

/** 开头说法外壳（不引入任何新事实，只是换个说法引入同一份答案） */
const OPENERS = [
  { id: 'plain', tag: '', text: (a) => a },
  { id: 'blunt', tag: '说白了，', text: (a) => `说白了，${a}` },
  { id: 'simple', tag: '简单说，', text: (a) => `简单说，${a}` },
  { id: 'direct', tag: '直接说结论：', text: (a) => `直接说结论：${a}` },
  { id: 'sort', tag: '给你捋一下：', text: (a) => `给你捋一下：${a}` },
  { id: 'exp', tag: '按我自己的经验，', text: (a) => `按我自己的经验，${a}` },
  { id: 'easy', tag: '这个好办，', text: (a) => `这个好办，${a}` },
  { id: 'plain2', tag: '其实很简单，', text: (a) => `其实很简单，${a}` },
  { id: 'suggest', tag: '我的建议是，', text: (a) => `我的建议是，${a}` },
  { id: 'habit', tag: '我一般这么干，', text: (a) => `我一般这么干，${a}` },
  { id: 'first', tag: '先说答案：', text: (a) => `先说答案：${a}` },
  { id: 'calm', tag: '不用纠结，', text: (a) => `不用纠结，${a}` },
  { id: 'honest', tag: '讲真，', text: (a) => `讲真，${a}` },
  { id: 'serious', tag: '认真答一下：', text: (a) => `认真答一下：${a}` },
  { id: 'sure', tag: '给你个准话：', text: (a) => `给你个准话：${a}` },
  { id: 'veteran', tag: '老玩家都这么干，', text: (a) => `老玩家都这么干，${a}` },
];

/** 结尾补充（可选，只在部分变体上加，避免每条都拖泥带水） */
const CLOSERS = [
  { id: 'hope', text: '差不多就这些，试试看～' },
  { id: 'easy', text: '先按这个来，慢慢就顺了' },
  { id: 'ask', text: '还有不懂的直接问就行～' },
  { id: 'share', text: '有更好的打法也欢迎补充～' },
  { id: 'step', text: '卡在具体哪一步可以再贴出来' },
  { id: 'patience', text: '别急着一次到位，边打边调' },
  { id: 'should', text: '照这个思路应该能过去' },
  { id: 'update', text: '有啥变化随时来说一声' },
  { id: 'version', text: '版本一更新记得回头看一眼' },
  { id: 'steady', text: '按这个走，别被别的说法带偏' },
  { id: 'loose', text: '小细节别太较真，能过就行' },
  { id: 'switch', text: '真不顺手就换个思路，不磕这一关' },
  { id: 'shot', text: '有截图的话我能说得更准' },
  { id: 'time', text: '思路对了剩下就是时间问题' },
  { id: 'back', text: '遇到坑了回来说，我帮你看' },
  { id: 'ref', text: '以上都是我自己的打法，供参考' },
];

import { stableHash, liteHash } from './util.mjs';

/** 内部信息/不该出现在公开回复里的东西 */
const LEAK_PATTERNS = [
  /答疑库|资料库|知识库/,
  /state\.json|config\.json|qa-usage|\.mjs|\.json\b/,
  /scripts\/|references\/|assets\/|data\//,
  /opencli|selenium|playwright|puppeteer|CDP|调试模式/,
  /机器人|AI\s*助手|自动化脚本|爬虫|抓取接口|webapiv2/,
  /API\s*限流|WAF|阿里云/i,
  /prompt|system\s*prompt|api\s*key|token|cookie/i,
];

/**
 * 泄露自检：命中任一模式就判定为「不该发出去」
 * @returns {{ok:boolean, hit?:string}}
 */
export function assertNoLeak(text) {
  const t = String(text || '');
  for (const re of LEAK_PATTERNS) {
    const m = t.match(re);
    if (m) return { ok: false, hit: m[0] };
  }
  return { ok: true };
}

// 散列统一放在 lib/util.mjs（原来这里和 praise.mjs 各抄了一份，改一边忘另一边就出 bug）

/**
 * 拆出答案末尾的表情标记
 *
 * 答疑库里有不少答案是以表情收尾的（「…慢慢来就好啦[表情_开心]」）。
 * 一旦我们在后面加收尾句，表情就跑到句子中间去了，读起来像被截断：
 *   「…就好啦[表情_开心]\n\n差不多就这些，试试看～」  ← 别扭
 * 所以先把它摘出来，最后再放回句尾：
 *   「…就好啦\n\n差不多就这些，试试看～[表情_开心]」  ← 顺
 * （表情位置由 parseEmojiSegments 在最终字符串上重新算，挪动是安全的）
 */
const TAIL_EMOJI_RE = /(?:\s*\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\])+\s*$/;

function splitTailEmoji(text) {
  const s = String(text || '');
  const m = s.match(TAIL_EMOJI_RE);
  if (!m) return { core: s, tail: '' };
  return { core: s.slice(0, m.index).trimEnd(), tail: m[0].trim() };
}

/**
 * 给一份答案挑一个「没发过的说法」
 *
 * 选择顺序：
 *   1. 散列起点 = hash(帖子ID + 答案)（同一帖子重试结果稳定）
 *   2. **最近用过的开头 / 收尾自动排到最后**（玩家会翻你主页，别让他看出规律）
 *   3. 再避开一字不差发过的完整文本
 *   4. 全撞上才复用，并标记 duplicated
 *
 * @param {object} o
 * @param {string} o.answer            答疑库里的答案正文（事实来源）
 * @param {string} o.postId            帖子 ID（用于稳定散列）
 * @param {string[]} o.usedTexts       已经发过的完整文本
 * @param {string} [o.signature]       签名
 * @param {boolean} [o.allowCloser]    是否允许加结尾句（默认 true）
 * @returns {{text:string, opener:string, closer:string|null, duplicated:boolean}}
 */
export function buildReplyText({ answer, postId = '', usedTexts = [], signature = '', allowCloser = true }) {
  const { core, tail } = splitTailEmoji(String(answer || '').trim());
  const base = core;
  const recent = (usedTexts || []).filter(Boolean).map(String);
  const used = new Set(recent.map((t) => liteHash(t)));

  // 最近用过的开头 / 收尾
  const usedOpeners = new Set(
    OPENERS.filter((op) => op.tag && recent.some((t) => t.startsWith(op.tag))).map((op) => op.id)
  );
  const usedClosers = new Set(
    CLOSERS.filter((cl) => recent.some((t) => t.includes(cl.text))).map((cl) => cl.id)
  );

  const seed = stableHash(`${postId}|${base}`);
  const start = seed % OPENERS.length;
  const closerStart = (seed >> 3) % CLOSERS.length;

  const candidates = [];
  for (let i = 0; i < OPENERS.length; i++) {
    const op = OPENERS[(start + i) % OPENERS.length];
    const body = `${op.text(base)}${tail}`;
    const plain = { opener: op.id, closer: null, body };
    if (!allowCloser) {
      candidates.push(plain);
      continue;
    }
    const cl = CLOSERS[(closerStart + i) % CLOSERS.length];
    const withCloser = { opener: op.id, closer: cl.id, body: `${op.text(base)}\n\n${cl.text}${tail}` };
    // 一半先给带收尾句的版本 —— 否则「无收尾」永远排在前面，
    // 收尾句实际上永远轮不到（第一版就是这个 bug，试运行才发现）
    if (i % 2 === 0) candidates.push(withCloser, plain);
    else candidates.push(plain, withCloser);
  }

  // 最近说过的口气往后排（稳定分区，不打乱组内相对顺序）
  const fresh = [];
  const stale = [];
  for (const c of candidates) {
    const seen = usedOpeners.has(c.opener) || (c.closer && usedClosers.has(c.closer));
    (seen ? stale : fresh).push(c);
  }

  for (const c of [...fresh, ...stale]) {
    const full = signature ? `${c.body}\n\n${signature}` : c.body;
    if (!used.has(liteHash(full))) {
      return { text: full, opener: c.opener, closer: c.closer, duplicated: false };
    }
  }

  // 全都用过了 → 取第一个（并标记为重复，交给上层决定是否跳过）
  const c = candidates[0];
  const full = signature ? `${c.body}\n\n${signature}` : c.body;
  return { text: full, opener: c.opener, closer: c.closer, duplicated: true };
}

/**
 * 委婉拒绝的文案（库里没有答案时可选使用，config.reply.refuseOnUnknown 才生效）
 * 口吻：承认不知道 + 不装懂 + 把球踢给懂的人，别写成免责声明。
 */
const REFUSALS = [
  '这个我真不敢乱讲，说错了反而坑你，蹲个真懂的大佬来',
  '这块我还没摸透，先别听我瞎猜，等个准话更好',
  '抱歉啊，这个超出我了解的范围了，怕带偏你，先不误导',
  '我也不太确定，别急，肯定有人踩过这个坑',
  '这个得看具体情况，我瞎说反而害你，先蹲一下',
  '没实测过的东西不敢乱教，等大佬们来说',
  '这个我真答不上来，别急，会有人懂的',
  '不确定的地方我就不乱说了，怕坑到你',
];

export function buildRefusalText(postId = '', withEmoji = true) {
  const t = REFUSALS[stableHash(postId) % REFUSALS.length];
  return withEmoji ? `${t}[表情_捂脸哭]` : t;
}

// ============================================================
// 分享帖轻互动
//
// 论坛大量帖子是「分享/记录/进度/吐槽」而不是提问（「只剩9没过了」「终于打过了」「又闪退了」）。
// 这类不该套答疑内容，但完全可以去说句话 —— 所以给一句通用轻互动 + 1 个表情。
//
// 硬约束：
//  - **只说话不输出信息**：不引用答疑库、不评价具体数值（避免泄露出错）
//  - **分情绪桶**：晒进度 → 夸他；吐槽翻车 → 跟着共鸣（用户给的标杆：
//    「正常，玩到正版了，拓维正常操作。」就是吐槽桶的口吻）
// ============================================================

/** 晒进度 / 晒成果 → 夸 */
const SHARE_PROGRESS = [
  '大佬，好肝啊{emoji}',
  '肝肝还好吗{emoji}',
  '这进度，我酸了{emoji}',
  '稳，坐等通关{emoji}',
  '厉害啊，追都追不上{emoji}',
  '这波可以，恭喜{emoji}',
  '牛，我先抄个作业{emoji}',
  '又来一个卷王{emoji}',
  '这肝度我给跪了{emoji}',
  '照这个速度我要掉队了{emoji}',
  '爽，看着就带劲{emoji}',
  '可以可以，稳稳的{emoji}',
  '进度条拉满了是吧{emoji}',
  '这波值得记一下{emoji}',
  '我还在前面那关磨呢{emoji}',
  '这就是传说中的效率{emoji}',
];

/** 吐槽 / 翻车 / 官方整活 → 共鸣（只表达"我也是"，不对官方下判断） */
const SHARE_TEASE = [
  '正常，玩到正版了{emoji}',
  '拓维正常操作{emoji}',
  '这波我懂，我也是这样{emoji}',
  '哈哈哈，见怪不怪了{emoji}',
  '老毛病了，别放心上{emoji}',
  '这游戏就这样，凑合玩{emoji}',
  '我已经习惯了，麻木{emoji}',
  '这也不是第一次了吧{emoji}',
  '淡定，明天说不定就好了{emoji}',
  '同款体验，握手{emoji}',
  '我上回也是这情况{emoji}',
  '这波真绷不住{emoji}',
  '离谱归离谱，还是得玩{emoji}',
  '笑死，我也遇到过{emoji}',
  '别气，气坏不值当{emoji}',
  '行吧，习惯了就好{emoji}',
];

const PROGRESS_EMOJIS = ['点赞', '加油', '星星眼', '比心', '可爱'];
const TEASE_EMOJIS = ['吃瓜', '笑哭了', '狗头', '斜眼笑', '汗'];

/** 吐槽/翻车特征（不涉及客服/退款这类要人工介入的，那些已经被敏感词挡掉） */
const TEASE_RE = /(崩了|闪退|卡死|白给|离谱|笑死|无语|麻了|阴间|正常操作|又又|真的服|蚌埠)/;

/**
 * 判断分享帖的情绪桶
 * @returns {'progress'|'tease'}
 */
export function shareMood(text = '') {
  return TEASE_RE.test(String(text || '')) ? 'tease' : 'progress';
}

/**
 * 生成分享帖的轻互动文案（单行，表情在句尾，签名在表情前）
 * @returns {{text:string, emoji:string, mood:string}}
 */
export function buildShareText({ postId = '', title = '', text = '', usedTexts = [], signature = '' }) {
  const mood = shareMood(`${title}${text ? ' ' + text : ''}`);
  const pool = mood === 'tease' ? SHARE_TEASE : SHARE_PROGRESS;
  const emojis = mood === 'tease' ? TEASE_EMOJIS : PROGRESS_EMOJIS;

  const seed = stableHash(`${postId}|${title}`);
  const recent = (usedTexts || []).filter(Boolean).map(String);
  const used = new Set(recent.map((t) => liteHash(t)));

  const build = (tpl, emoji) =>
    `${tpl.replace('{emoji}', '')}${signature ? ` ${signature}` : ''}[表情_${emoji}]`;

  // 最近说过的说法往后排（去掉 {emoji} 后拿正文比对）
  const cands = [];
  for (let i = 0; i < pool.length; i++) {
    const tpl = pool[(seed + i) % pool.length];
    const emoji = emojis[(seed + i) % emojis.length];
    const core = tpl.replace('{emoji}', '');
    const seen = recent.some((t) => t.includes(core));
    cands.push({ tpl, emoji, seen, text: build(tpl, emoji) });
  }
  for (const c of [...cands.filter((x) => !x.seen), ...cands.filter((x) => x.seen)]) {
    if (!used.has(liteHash(c.text))) return { text: c.text, emoji: c.emoji, mood };
  }
  const c = cands[0];
  return { text: c.text, emoji: c.emoji, mood };
}

// 供测试做下限断言用
export const POOL_SIZES = {
  openers: OPENERS.length,
  closers: CLOSERS.length,
  refusals: REFUSALS.length,
  shareProgress: SHARE_PROGRESS.length,
  shareTease: SHARE_TEASE.length,
};
