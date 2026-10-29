// 玩家喊我们 → 根据语义互动一下（用户 2026-10-29 要求）
//
// 场景：玩家在评论/楼中楼里喊我们（「小鲸鱼在吗」「@版主助手-小鲸鱼 这个怎么过」「谢谢版主」）。
// 之前这种帖子被当成「非提问」直接跳过 —— 玩家喊了半天没人理，很难看。
//
// 处理规则（用户明确给的边界）：
//   1. **触发敏感规则 → 拒绝**（退款/客服/补偿/封号/举报/充值/外挂/账号交易…），
//      礼貌说明「这不在我能处理的范围」，不替官方表态、不承诺任何结果。
//   2. 玩家同时问了具体问题 → **先用答疑库答**（事实只能来自库里，答不上来绝不瞎编）。
//   3. 其余 → 按语义分组互动：鼓励 / 赞扬 / 欣赏 / 同情 / 共情。
//   4. **绝不能贬低、辱骂、嘲讽玩家** —— 有 `assertKind` 硬护栏，发送前必过。
//
// ⚠️ 楼中楼 `fill` 不支持多行（硬约束 20）→ 这里所有文案**必须单行**，表情放句尾。
// ⚠️ 玩家会把所有回复翻一遍 → 每类模板池 ≥15 套，且最近说过的主动避开（同 lib/variants.mjs）。
//
// 纯启发式（无 LLM）：按关键词分桶。分不准时宁可给一句温和的兜底，也不装懂。

import { matchPost } from './qa.mjs';
import { tagsFromConfig } from './signature.mjs';
import { stableHash, liteHash } from './util.mjs';

// ------------------------------------------------------------
// 语义分桶（先命中先返回，顺序就是优先级）
// ------------------------------------------------------------
const MOOD_RULES = [
  [
    'sensitive',
    /(退款|退钱|退费|退游|客服|补偿|封号|被封|封禁|解封|举报|充值|消费|订单|支付|付款|申诉|投诉|外挂|作弊|破解|私服|源码|修改器|卖号|买号|收号|出号|交易|诈骗|骗子|骗钱|未成年|下架|版号|维权|12315|律师)/,
  ],
  ['thanks', /(谢谢|感谢|多谢|谢了|3q|thx|thanks|么么|爱了|感谢你)/],
  [
    'praiseMe',
    /(版主辛苦|辛苦版主|辛苦小鲸鱼|小鲸鱼辛苦|版主好棒|小鲸鱼好|版主真|版主牛|小鲸鱼牛|很负责|太负责|真负责|负责任|负责|用心|靠谱|版主好人)/,
  ],
  [
    'complain',
    /(闪退|崩溃|卡死|卡顿|掉线|白给|离谱|无语|服了|麻了|太难|打不过|过不去|气死|好烦|难受|心态崩|哭死|阴间|又又|真的服|折磨)/,
  ],
  ['celebrate', /(终于|通关|打过了|满级|太爽|开心|哈哈哈|成功|拿下|稳了|赢了|过了这关)/],
  [
    'help',
    /(怎么|如何|咋|哪个|多少|能不能|是不是|为什么|为啥|请问|求助|问下|问一下|有推荐|怎么办|用什么|配什么|哪关|打不过|有没有)/,
  ],
  ['greet', /(在吗|在不在|你好|您好|呼叫|来了吗|有人吗|有人在|hi|hello|嗨)/],
];

/**
 * 去掉「喊我们的那部分」，只留玩家真正问的那句
 *
 * 「小鲸鱼，困难6怎么过啊」→ 「困难6怎么过啊」
 * 不去掉的话，称呼会把匹配分数稀释掉（二元组分母变大、关键词命中没变），
 * 结果是明明问对了却匹配不上、只能回一句「我不敢乱猜」。
 */
export function stripAddress(text, config) {
  let t = String(text || '');
  for (const tag of tagsFromConfig(config)) {
    if (!tag) continue;
    t = t.split(tag).join(' ');
  }
  return t
    .replace(/[@＠]/g, ' ')
    .replace(/[，,。、！!？?~～\s]+/g, ' ')
    .trim();
}

/**
 * 判断一条「喊我们」的评论属于哪种语气
 * @returns {'sensitive'|'praiseMe'|'thanks'|'complain'|'celebrate'|'help'|'greet'|'other'}
 */
export function detectMood(text) {
  const t = String(text || '');
  for (const [mood, re] of MOOD_RULES) if (re.test(t)) return mood;
  return 'other';
}

// ------------------------------------------------------------
// 文案池（单行；{name} = 玩家昵称；{emoji} = 句尾表情，由脚本点选插入）
// 每类 ≥15 套，往下只能加不能减（test-summon.mjs 有下限断言）
// ------------------------------------------------------------
export const SUMMON_TEMPLATES = {
  greet: [
    '{name} 在的在的，你说{emoji}',
    '来了来了{emoji}',
    '在呢，啥事{emoji}',
    '在，随时说{emoji}',
    '在的，刚巡完一圈回来{emoji}',
    '{name} 找我啥事{emoji}',
    '在，你讲{emoji}',
    '嘿，我在{emoji}',
    '来啦，有啥要问的{emoji}',
    '在的，别急慢慢说{emoji}',
    '{name} 我在的{emoji}',
    '在，说吧{emoji}',
    '在这呢{emoji}',
    '在的，值班中{emoji}',
    '喊我干啥，我在{emoji}',
    '在，有事直接讲{emoji}',
  ],
  thanks: [
    '客气了{emoji}',
    '不用谢，应该的{emoji}',
    '{name} 别客气{emoji}',
    '举手之劳而已{emoji}',
    '能帮上就好{emoji}',
    '小事情，别放心上{emoji}',
    '哈哈没事，随时来问{emoji}',
    '不用谢，帮到你就行{emoji}',
    '客气啥，都玩一个游戏的{emoji}',
    '{name} 太客气了{emoji}',
    '这有啥，应该的{emoji}',
    '别谢了，下次直接问{emoji}',
    '能解决就好{emoji}',
    '不客气，玩得开心{emoji}',
    '应该的，有问题再来{emoji}',
    '嗨，小事{emoji}',
  ],
  praiseMe: [
    '别夸我，会飘的{emoji}',
    '主要是大家问题问得清楚{emoji}',
    '{name} 你这话我爱听{emoji}',
    '没那么厉害，就是看得多{emoji}',
    '哈哈，被发现了{emoji}',
    '辛苦啥，习惯成自然了{emoji}',
    '这话我收下了{emoji}',
    '抬举了抬举了{emoji}',
    '被夸得不好意思了{emoji}',
    '都是自己玩出来的经验{emoji}',
    '谢谢认可，我继续蹲着{emoji}',
    '这波夸奖我记小本本上了{emoji}',
    '别别，我怕骄傲{emoji}',
    '{name} 你这么说我更得认真答了{emoji}',
    '啥也没干，就是守着这儿{emoji}',
    '被你说得有点上头{emoji}',
  ],
  complain: [
    '这关确实恶心，不是你的问题{emoji}',
    '我懂，我当初也卡了很久{emoji}',
    '别急，慢慢磨总能过{emoji}',
    '太真实了，我也是这么过来的{emoji}',
    '{name} 抱抱，别气{emoji}',
    '这游戏就这样，心态放平{emoji}',
    '谁没被这关坑过呢{emoji}',
    '难是难，不是没解{emoji}',
    '我懂那种感觉，血压上来了{emoji}',
    '别跟自己较劲，歇会儿再打{emoji}',
    '正常，翻车人人都翻{emoji}',
    '这波不怪你，关卡就这么设计的{emoji}',
    '稳住，多试几次就顺了{emoji}',
    '看着都替你难受{emoji}',
    '{name} 别灰心，后面还有机会{emoji}',
    '气归气，还是得玩对吧{emoji}',
  ],
  celebrate: [
    '牛啊，恭喜{emoji}',
    '终于过了，爽吧{emoji}',
    '{name} 可以啊{emoji}',
    '这波值得庆祝一下{emoji}',
    '稳，看着都替你爽{emoji}',
    '厉害，我还在前面磨{emoji}',
    '恭喜恭喜，血赚{emoji}',
    '过了就好，可以歇口气了{emoji}',
    '这进度可以的{emoji}',
    '牛，我先鼓个掌{emoji}',
    '哈哈这就是坚持的回报{emoji}',
    '{name} 这波真的稳{emoji}',
    '过了这关后面就轻松了{emoji}',
    '干得漂亮{emoji}',
    '恭喜通关，记得截图留念{emoji}',
    '这波我给你点赞{emoji}',
  ],
  help: [
    '这个我不敢乱猜，说错了坑你，等个真懂的大佬{emoji}',
    '说实话这块我也没底，别听我瞎讲{emoji}',
    '问题我记下了，看到准的我回来补一句{emoji}',
    '{name} 这个我得再确认下，别急{emoji}',
    '我暂时给不出准话，怕带偏你{emoji}',
    '这个超出我范围了，我不敢装懂{emoji}',
    '先别急着动，等我摸清楚再说{emoji}',
    '问得好，可惜我真没实测过{emoji}',
    '这块我没经验，就不乱说了{emoji}',
    '你这情况有点特殊，我瞎说反而害你{emoji}',
    '我查过类似的，但没有准答案{emoji}',
    '先蹲一下，会有人给出准话的{emoji}',
    '{name} 这个我真答不上，别怪我{emoji}',
    '不好说，情况不一样结论会变{emoji}',
    '我记一下，弄明白了来说{emoji}',
    '别急着信我，这种还是多问几个人{emoji}',
  ],
  sensitive: [
    '这个我真处理不了，退款封号这类得走官方客服{emoji}',
    '抱歉啊，这属于官方那边的事，我插不上手{emoji}',
    '这类问题我帮不上忙，得找官方渠道{emoji}',
    '我就是个答疑的，这种真管不了{emoji}',
    '别听我这种野路子，这种得官方认定{emoji}',
    '这个我不好评价，走正规渠道更靠谱{emoji}',
    '{name} 这事我说了不算，得官方{emoji}',
    '抱歉，这种我不方便乱讲{emoji}',
    '涉及账号和消费的，只能走官方{emoji}',
    '我不敢给这种建议，怕耽误你{emoji}',
    '这个不归我管，帮不上真的抱歉{emoji}',
    '理解你着急，但这个真得找官方{emoji}',
    '我只答游戏内玩法，这种帮不了{emoji}',
    '这类问题直接找官方更有效{emoji}',
    '抱歉，这个我没法替你判断{emoji}',
    '换个玩法问题我还能聊，这个真不行{emoji}',
  ],
  other: [
    '收到，我在看着呢{emoji}',
    '嗯嗯，接着说{emoji}',
    '{name} 我在，你慢慢说{emoji}',
    '这波我没太看懂，你再说细点{emoji}',
    '好，记下了{emoji}',
    '行，我懂你意思了{emoji}',
    '嗨，小事情{emoji}',
    '嗯，那确实{emoji}',
    '听着挺有意思的{emoji}',
    '你说的我认{emoji}',
    '我在听，别急{emoji}',
    '哈哈，明白{emoji}',
    '{name} 看到了{emoji}',
    '你这么一说我也这么觉得{emoji}',
    '了解了解{emoji}',
    '有道理{emoji}',
  ],
};

/** 每类语气配一组表情（只用第 1 组标准表情，见 references/emojis.md） */
export const SUMMON_EMOJIS = {
  greet: ['开心', '可爱', 'wink', '举手', '期待'],
  thanks: ['比心', '送花', '开心', '可爱', '点赞'],
  praiseMe: ['羞涩', '可爱', '不好意思', '星星眼', '比心'],
  complain: ['加油', '比心', '叹气', '祈祷', '泪目'],
  celebrate: ['点赞', '星星眼', '加油', '酷', '大笑'],
  help: ['捂脸哭', '思考', '加油', '汗', '祈祷'],
  sensitive: ['叹气', '不好意思', '捂脸哭', '冷漠', '委屈'],
  other: ['开心', '可爱', '狗头', '吃瓜', '微笑'],
  qa: ['点赞', '思考', '灵光一闪', '比心', '加油'],
};

/** 用答疑库直接作答时的开场（单行；空串 = 不加开场，直接说答案） */
export const QA_LEADS = [
  '',
  '这个我知道，',
  '正好我懂，',
  '刚好答过类似的，',
  '这个简单，',
  '直接说，',
  '按我的经验，',
  '给你个准话，',
  '之前也有人问过，',
  '我试过，',
  '不用纠结，',
  '说白了，',
  '一句话，',
  '这题我有答案，',
  '刚查过，',
  '正经答一下，',
];

// ------------------------------------------------------------
// 安全护栏
// ------------------------------------------------------------

/** 可能贬低/嘲讽玩家的词（用户明确不允许） */
const BELITTLE_RE =
  /(傻|蠢|笨|弱智|脑残|废物|垃圾|滚蛋|滚开|闭嘴|菜鸡|丢人|活该|自己笨|别问了|懒得理|不关我事|爱信不信|无所谓了|自己去查|你懂什么)/;

/** 不能替官方承诺/表态（我们不是官方，承诺了会出事） */
const OVERPROMISE_RE =
  /(保证|肯定修|一定修|马上修|会补偿|给补偿|内部消息|官方说了|我们官方|包过|百分百|一定赔)/;

/**
 * 文案护栏：不贬低玩家、不替官方承诺
 * @returns {{ok:boolean, hit?:string}}
 */
export function assertKind(text) {
  const t = String(text || '');
  let m = t.match(BELITTLE_RE);
  if (m) return { ok: false, hit: `贬低用词「${m[0]}」` };
  m = t.match(OVERPROMISE_RE);
  if (m) return { ok: false, hit: `越权承诺「${m[0]}」` };
  return { ok: true };
}

// ------------------------------------------------------------
// 组装文案
// ------------------------------------------------------------

/** 把答疑库答案压成单行（楼中楼编辑器不支持多行） */
export function flattenAnswer(answer) {
  const tail = /(?:\s*\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\])+\s*$/;
  const m = String(answer || '').match(tail);
  const core = String(answer || '').replace(tail, '');
  const flat = core
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { flat, tail: m ? m[0].trim() : '' };
}

/** 玩家昵称：太长截断，空则用「大佬」 */
function displayName(author) {
  const n = String(author || '').trim();
  if (!n) return '大佬';
  return n.length > 8 ? n.slice(0, 8) : n;
}

/**
 * 生成一条「喊话互动」文案
 *
 * @param {object} o
 * @param {string} o.text        玩家那条评论的正文
 * @param {string} [o.author]    玩家昵称
 * @param {string} [o.postId]    帖子 ID（散列用，保证同一帖结果稳定）
 * @param {object} o.config
 * @param {Array}  [o.qa]        答疑库（用于「顺便把问题答了」）
 * @param {string[]} [o.usedTexts] 已发过的文本（避免重样）
 * @returns {{text:string, mood:string, emoji:string, fromQa:boolean, qaQuestion?:string, qaId?:string, duplicated:boolean}}
 */
export function buildSummonReply({
  text = '',
  author = '',
  postId = '',
  config = {},
  qa = [],
  usedTexts = [],
  matcher = matchPost,
}) {
  const mood = detectMood(text);
  const name = displayName(author);
  const sig = config?.summon?.signature === false ? '' : String(config?.reply?.signature || '');
  const wantEmoji = config?.reply?.emoji?.enabled !== false;
  const recent = (usedTexts || []).filter(Boolean).map(String);
  const used = new Set(recent.map((t) => liteHash(t)));

  const finish = (body, emoji, bucket, extra = {}) => {
    const line = String(body)
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/[，、]$/, '');
    const full =
      `${line}${sig ? ` ${sig}` : ''}` + (wantEmoji && emoji ? `[表情_${emoji}]` : '');
    return { text: full, mood: bucket, emoji: wantEmoji ? emoji : null, duplicated: used.has(liteHash(full)), ...extra };
  };

  // ---- 1. 敏感：一律礼貌拒绝，不看答疑库、不给建议 ----
  if (mood === 'sensitive') {
    const pool = SUMMON_TEMPLATES.sensitive;
    const emojis = SUMMON_EMOJIS.sensitive;
    const pick = pickTemplate({ pool, emojis, seed: stableHash(`${postId}|sensitive`), name, recent, used });
    return finish(pick.body, pick.emoji, 'sensitive');
  }

  // ---- 2. 同时问了具体问题 → 先查答疑库（事实只能来自库里）----
  if (config?.summon?.answerFromQa !== false && Array.isArray(qa) && qa.length) {
    try {
      // 先把「小鲸鱼，」这类称呼去掉再匹配，否则称呼会稀释分数
      const query = stripAddress(text, config);
      const cands = query ? matcher(query, qa, 3) : [];
      const top = cands?.[0];
      // 喊话场景的阈值比常规回复略低（玩家是点名问我们的，短问句本就该放宽一点）
      const need = Number(config?.summon?.qaScore ?? config?.match?.autoReplyScore ?? 0.65);
      if (top && top.score >= need) {
        const { flat, tail } = flattenAnswer(top.entry.answer);
        if (flat) {
          const lead = QA_LEADS[stableHash(`${postId}|${top.entry.question}`) % QA_LEADS.length];
          const pool = SUMMON_EMOJIS.qa;
          const emoji = tail
            ? (String(tail).match(/\[表情_([^\]]+)\]/)?.[1] || pool[0])
            : pool[stableHash(`${postId}|qemoji`) % pool.length];
          const body = `${lead}${flat}`;
          const r = finish(body, emoji, 'qa', {
            fromQa: true,
            qaQuestion: top.entry.question,
            qaId: top.entry.id,
            score: Number(top.score.toFixed(3)),
          });
          // QA 命中且护栏拦下（极少见）→ 退化成 help 文案，不硬发可疑内容
          if (assertKind(r.text).ok) return r;
        }
      }
    } catch {
      /* 匹配异常就退回情绪互动，不影响主流程 */
    }
  }

  // ---- 3. 情绪互动 ----
  const bucket = SUMMON_TEMPLATES[mood] ? mood : 'other';
  const pick = pickTemplate({
    pool: SUMMON_TEMPLATES[bucket],
    emojis: SUMMON_EMOJIS[bucket] || SUMMON_EMOJIS.other,
    seed: stableHash(`${postId}|${bucket}`),
    name,
    recent,
    used,
  });
  return finish(pick.body, pick.emoji, bucket, { fromQa: false });
}

/**
 * 从池子里挑一句：最近说过的排后面，再避开一字不差发过的
 */
function pickTemplate({ pool, emojis, seed, name, recent, used }) {
  const render = (tpl, emoji) =>
    String(tpl)
      .replace(/\{name\}/g, name)
      .replace(/\{emoji\}/g, '')
      .trim();

  const cands = [];
  for (let i = 0; i < pool.length; i++) {
    const tpl = pool[(seed + i) % pool.length];
    const emoji = emojis[(seed + i) % emojis.length];
    const body = render(tpl, emoji);
    const text = `${body}[表情_${emoji}]`;
    const seen = recent.some((t) => t.includes(body));
    cands.push({ body, emoji, seen, text });
  }
  const ordered = [...cands.filter((c) => !c.seen), ...cands.filter((c) => c.seen)];
  for (const c of ordered) {
    if (!used.has(liteHash(c.text))) return c;
  }
  return cands[0];
}

/** 供测试做下限断言 */
export const POOL_SIZES = Object.fromEntries(
  Object.entries(SUMMON_TEMPLATES).map(([k, v]) => [k, v.length])
);
