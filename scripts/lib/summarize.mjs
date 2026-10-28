// 从「他人已有回复」中自动总结出一条 QA 条目
//
// 目的：社区里已经有人答过的问题，不该再由我们重复回答；
//      但那份答案很有价值 —— 把它沉淀进答疑库，以后同类问题就能自动回。
//
// 总结策略（无人值守可用，纯启发式，不依赖 LLM）：
//   1. 展开所有回复（含楼中楼）→ 去重 → 滤掉无信息量的（太短/纯表情/接龙）
//   2. 给每条打分：答疑类徽章 +N、版主 +N、内容具体度（长度/含数字）+N
//   3. 最高分作为主答案，其余有信息量的作为「补充：」
//   4. 关键词从标题/摘要滑窗抽取（宽松优先，宁多勿漏，方便匹配）
//
// 自动沉淀的条目会带「来源」「总结时间」，且匹配分数打 0.9 折（低于人工条目），
// 避免把未经人工复核的答案直接自动发出去。

const NOISE = [
  '顶', '沙发', '地板', '哈哈哈', '哈哈', '同问', '蹲', '前排', 'mark', '收藏',
  '谢谢', '感谢', '学习', '666', '牛', '厉害', '确实', '是的', '对', '嗯', '哦',
  '啊这', '离谱', '笑死', '泪目', '打卡', '路过',
];

/** 摊平回复树（含楼中楼），去重 */
export function flattenReplies(list) {
  const out = [];
  const seen = new Set();
  for (const c of list || []) {
    pushOne(c);
    for (const ch of c.child_posts || []) pushOne(ch, c.id_str);
  }
  return out;

  function pushOne(c, parentId) {
    const text = String(c.contents?.json?.[0]?.children?.[0]?.text || '').trim();
    if (!text) return;
    if (seen.has(text)) return;
    seen.add(text);
    out.push({
      id: String(c.id_str || ''),
      parentId: parentId || null,
      text,
      author: c.author?.name || '匿名',
      authorId: String(c.author?.id || ''),
      isModerator: !!c.author?.is_moderator,
      badges: (c.author?.badges || []).map((b) => b.title).filter(Boolean),
      time: Number(c.created_time || 0),
      ups: Number(c.ups || 0),
    });
  }
}

/** 是否是无信息量的回复 */
export function isNoise(r) {
  const t = r.text.replace(/\[表情[^\]]*\]/g, '').trim();
  if (t.length < 4) return true;
  if (NOISE.some((n) => t === n || t.replace(/[！!。，,.？?~～]/g, '') === n)) return true;
  if (!/[一-龥a-zA-Z0-9]/.test(t)) return true; // 纯表情/符号
  return false;
}

/**
 * 是否是一条「值得沉淀 / 值得夸」的有效回答
 *
 * 比 isNoise 严格得多 —— isNoise 只挡「太短 / 纯表情」，这里要挡
 * 「看着像答案、其实是废话」：
 *   - 「如果不行就找客服」→ 客服引导，不是答疑
 *   - 「你是不是没有更新？」→ 纯反问
 *   - 「谢了兄弟下个月找我」→ 私下交换
 *   - 「不是氪这么多」→ 碎片，没有完整信息
 */
const JUNK_PATTERNS =
  /客服|找官方|私聊|私信|关注我|加我|找我|互赞|互换|交换|兑换码|退款|举报|充值|封号|加群|滴滴|联系方式|留个?号/;

// 兑换码特征：一段 ≥6 位、含字母的纯字母数字串（如 JFA6Ds3Jcl）
const CODE_RE = /[A-Za-z][A-Za-z0-9]{5,}/;

export function isUsefulAnswer(r) {
  const t = String(r.text || '')
    .replace(/\[表情[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 12) return false; // 太短，多半是接话/碎片
  if (JUNK_PATTERNS.test(t)) return false; // 客服引导 / 私下交易 / 敏感
  if (CODE_RE.test(t)) return false; // 贴兑换码
  if (/[?？]\s*$/.test(t) && t.length < 20) return false; // 纯反问
  if (!/[一-龥]/.test(t)) return false; // 没有中文说明，多半是贴码
  return true;
}

/** 给一条回复打分 */
export function scoreReply(r) {
  let s = 0;
  if (r.badges.some((b) => /答疑|助人|专家|百科|达人/.test(b))) s += 4;
  if (r.isModerator) s += 4;
  if (r.ups > 0) s += Math.min(2, r.ups / 5);
  // 内容具体度：长度适中最佳，太长像灌水
  const len = r.text.length;
  s += len >= 8 && len <= 120 ? 2 : len > 120 ? 1 : 0;
  if (/\d/.test(r.text)) s += 1; // 有具体数字（数量/关卡/版本）更可能是答案
  if (/[?？]/.test(r.text)) s -= 1; // 反问不算答案
  return s;
}

/** 摘取关键句：去掉口水话与表情标记 */
export function tidy(text) {
  return String(text)
    .replace(/\[表情[^\]]*\]/g, '')
    .replace(/[（(]?\s*(顶|沙发|地板|打卡|路过)\s*[)）]?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 生成 QA 条目
 *
 * ⚠️ 必须排除「我自己发的评论」。
 *
 * 事故（2026-10-28 排查发现）：`scoreReply` 给版主 +4、给答疑徽章 +4，
 * 而我自己就是版主 → **我在别人答案下面盖的楼（夸奖）永远是最低分最高的那条**，
 * 于是被当成「最佳答案」沉淀进答疑库，库里出现了一堆：
 *   「回忆之旅乱码」→ 答案 = 「依******梦 说得又准又细，省了大家很多摸索 「版主助手-小鲸鱼」」
 *   「这地形和这关卡名字」→ 答案 = 「g 说得又准又细，省了大家很多摸索」
 *   「私人拖尾」→ 真实答案 + 「补充：谢谢 1******3 耐心解答…」
 * 这些条目一旦命中就会把夸奖句当答案发出去。
 *
 * @param {object} o
 * @param {string} [o.myUserId]  我的用户 ID（排除自己的评论）
 * @param {string} [o.signature] 我用的签名（双保险：含签名的评论一律不算答案）
 */
export function buildQaEntry({ post, comments, now = new Date(), myUserId = '', signature = '' }) {
  const selfId = String(myUserId || '__none__');
  const sig = String(signature || '').trim();

  /** 是不是我自己发的（三种判据任一命中即排除） */
  const isMine = (r) => {
    if (r.authorId && r.authorId === selfId) return true;
    const t = String(r.text || '');
    if (/版主助手|小鲸鱼/.test(t)) return true;
    if (sig && t.includes(sig)) return true;
    return false;
  };

  // 只沉淀「有效回答」—— 挡掉客服引导/私下交换/纯反问/碎片，避免答疑库被垃圾条目污染
  const replies = flattenReplies(comments).filter((r) => !isMine(r) && !isNoise(r) && isUsefulAnswer(r));
  if (!replies.length) return null;

  const scored = replies
    .map((r) => ({ ...r, score: scoreReply(r) }))
    .sort((a, b) => b.score - a.score || b.time - a.time);

  const main = scored[0];
  const extras = scored.slice(1).filter((r) => r.score >= 3 && tidy(r.text).length >= 6).slice(0, 2);

  const answerParts = [tidy(main.text)];
  for (const e of extras) answerParts.push(`补充：${tidy(e.text)}`);

  const question = (post.title || post.text || '').trim().slice(0, 60);
  const keywords = extractKeywords(post.title || '', post.text || '');

  return {
    question,
    keywords,
    answer: answerParts.join('\n'),
    source: post.url,
    summarizedAt: formatTime(now),
    fromAuthor: main.author,
    fromBadges: main.badges,
  };
}

/** 关键词抽取：4 字词块（精确）+ 2 字词（召回）+ 数字/英文
 *  刻意宽松（宁可多命中，人工再筛）。
 *  4 字块保证语义完整，2 字词保证换个说法也能命中。
 */
export function extractKeywords(title, text) {
  const src = `${title} ${text || ''}`.slice(0, 120).replace(/\s+/g, ' ');
  const STOP_PREFIX =
    /^(怎么|如何|什么|有没有|是不是|能不能|为什么|请问|求助|一下|这个|那个|可以|时候|知道|大佬|萌新|新手)/;

  // 数字、英文、版本号优先
  // ⚠️ 滤掉「活动编号 / UID / 兑换码」噪音：
  //   纯数字 ≥6 位（1234567890）、以字母开头的长码（JFA6Ds3Jcl / JFAMcG6Ne7）
  //   留着它们会让沉淀条目的关键词变成一串数字，对别的问法毫无匹配价值
  const nums = [];
  for (const m of src.match(/[a-zA-Z][a-zA-Z0-9]{1,}|\d+(?:\.\d+)?[a-zA-Z]?/g) || []) {
    if (m.length < 2) continue;
    if (/^\d{6,}$/.test(m)) continue;
    if (/^[a-zA-Z][a-zA-Z0-9]{5,}$/.test(m)) continue;
    nums.push(m);
  }

  const blocks = []; // 4 字不重叠块，语义完整
  const twos = []; // 2 字词，保召回
  for (const seg of src.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 4 <= seg.length; i += 4) {
      const w = seg.slice(i, i + 4);
      if (!STOP_PREFIX.test(w)) blocks.push(w);
    }
    for (let i = 0; i + 2 <= seg.length; i++) {
      const w = seg.slice(i, i + 2);
      if (!STOP_PREFIX.test(w)) twos.push(w);
    }
  }

  const out = [];
  const seen = new Set();
  for (const w of [...nums, ...blocks, ...twos]) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 追加条目到 QA 库文件（只追加，不覆盖已有内容）
 * @returns {{added:boolean, reason?:string}}
 */
export async function appendQaEntry(file, entry) {
  const { readFile, writeFile, access } = await import('node:fs/promises');
  let raw = '';
  try {
    await access(file);
    raw = await readFile(file, 'utf8');
  } catch {
    raw = '# 植物大战僵尸2 · 答疑库\n';
  }
  // 去重：同一来源链接不重复收录
  if (entry.source && raw.includes(entry.source)) {
    return { added: false, reason: 'source_exists' };
  }
  const kw = entry.keywords.length ? entry.keywords.join(', ') : '';
  const block =
    `\n## 问：${entry.question}\n` +
    (kw ? `- 关键词：${kw}\n` : '') +
    `- 来源：${entry.source}\n` +
    `- 总结时间：${entry.summarizedAt}\n` +
    `- 摘自：${entry.fromAuthor}${entry.fromBadges?.length ? `（${entry.fromBadges.join('/')}）` : ''}\n` +
    `---\n${entry.answer}\n`;
  await writeFile(file, raw.replace(/\s*$/, '\n') + block, 'utf8');
  return { added: true };
}
