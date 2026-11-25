// QA 知识库解析 + 匹配打分
//
// QA 库格式（Markdown，人可直接编辑，改完下一轮自动生效）：
//
//   ## 问：钻石怎么快速获得
//   - 关键词：钻石, 刷钻, 免费钻石
//   - 版本：通用
//   ---
//   回复正文，可以多行。
//
// ## 两种存储形态（2026-11-25 多人协作改造）
//
// ① 单文件 `qa/答疑库.md` —— 旧形态，仍支持（兼容期保留）
// ② 一条一文件 `qa/entries/<id>.md` —— 新形态，多人并行加条目不撞 git 冲突
//
// 条目文件可含**多个要点**（claim），每点带自己的置信度与来源：
//
//   ---
//   id: q-塔黄无尽搭配
//   question: 买了塔黄无尽用什么好
//   keywords: [塔黄, 保龄球]
//   ---
//   ## 要点
//   - [70%] 优先买神器保龄球
//     - 来源: https://…
//   - [50%] 卡波建议塔黄空吸到最高
//
// **下游零改动**：多要点会被拼成 answer 供既有检索/回复逻辑使用，
// 结构化 claims 供合并与置信度聚合使用。

import { readFile } from 'node:fs/promises';
import { readAllEntries, confLabelOf as entryConfLabelOf, plainTextOf } from './qa-entry.mjs';
import { qaEntriesDirOf } from './paths.mjs';

const STOP = new Set(
  ('的了是我你他她它吗呢吧啊呀哦在有和就都也不没很还这那什么怎么为什么如何哪个可以能不能请问一下帮帮忙' +
    '大佬新人小白求助问题游戏植物僵尸关卡怎么过怎么打有没有人知道谢谢大家')
    .split('')
);

/**
 * 条目文件 → 与 parseQa 相同形状的 entry
 * 下游（打分 / 回复 / 组装）不用改，只多了 claims 与稳定 id
 */
export function entryToQa(entry) {
  const claims = entry.claims || [];
  // answer = 纯文本（要点拼接，或原始正文）—— 下游照旧当一段正文用
  const answer = plainTextOf(entry);
  // 置信度：frontmatter 优先；否则取要点里最高的
  let confidence = entry.confidence;
  if (confidence == null && claims.length) {
    const nums = claims.map((c) => c.confidence).filter((n) => Number.isFinite(n));
    confidence = nums.length ? Math.max(...nums) : null;
  }
  if (confidence == null) confidence = entry.source ? 50 : 95;
  return {
    question: entry.question,
    keywords: entry.keywords || [],
    version: entry.version || '通用',
    signature: entry.signature || null,
    source: entry.source || null,
    summarizedAt: entry.updated || null,
    confidence,
    confidenceLabel: entryConfLabelOf(confidence),
    auto: !!entry.source,
    semanticConfirm: !!entry.semanticConfirm,
    answer,
    id: entry.id,            // 稳定 id（不再随问法漂移）
    claims,                 // 结构化要点（合并/聚合用）
  };
}

/** 加载条目目录（一一文件形态） */
export async function loadQaEntries(dir) {
  const entries = await readAllEntries(dir);
  return entries.map(entryToQa);
}

/**
 * 加载答疑库：优先条目目录，没有则退回单文件
 * @param {string} file 单文件路径（兼容）
 * @param {string} [dir] 条目目录（优先）
 */
export async function loadQaLibraryAny(file, dir) {
  if (dir) {
    const entries = await loadQaEntries(dir);
    if (entries.length) return entries;
  }
  return loadQaLibrary(file);
}

/**
 * 加载答疑库
 *
 * 2026-11-25 起：**优先读条目目录**（一条一文件），目录不存在或为空时退回单文件。
 * 这样所有调用点零改动就能用上新形态，且任何时候都能退回旧形态。
 *
 * @param {string} file 单文件路径（兼容）
 * @param {object} [o]
 * @param {string} [o.dir] 条目目录（默认从 file 推导：同级的 entries/）
 * @param {string} [o.mode] 'auto'（默认）| 'entries'（强制条目目录）| 'file'（强制单文件）
 */
export async function loadQaLibrary(file, o = {}) {
  const mode = o.mode || 'auto';
  const dir = o.dir || qaEntriesDirOf(file);
  if (mode !== 'file' && dir) {
    const entries = await loadQaEntries(dir);
    if (entries.length) return entries;
    if (mode === 'entries') return [];
  }
  const raw = await readFile(file, 'utf8');
  return parseQa(raw);
}

export function parseQa(raw) {
  const entries = [];
  const chunks = raw.split(/\n(?=##\s)/g);
  for (const chunk of chunks) {
    const headMatch = chunk.match(/^##\s*(?:问[:：]\s*)?(.+)$/m);
    if (!headMatch) continue;
    const question = headMatch[1].trim();

    // 元数据只在 `---` 之前找！否则正文里的「来源：」「版本：」会被误判成元数据
    const sep = chunk.indexOf('\n---');
    const meta = sep >= 0 ? chunk.slice(0, sep) : chunk;
    const answer = (sep >= 0 ? chunk.slice(sep + 4) : '').trim();
    if (!answer) continue;

    const kwMatch = meta.match(/关键词[:：]\s*(.+)/);
    const keywords = kwMatch
      ? kwMatch[1]
          .split(/[,，、;；\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const verMatch = meta.match(/版本[:：]\s*(.+)/);
    const version = verMatch ? verMatch[1].trim() : '通用';

    // 可选：单条 QA 自带签名，覆盖全局 config.reply.signature
    const sigMatch = meta.match(/签名[:：]\s*(.+)/);
    const signature = sigMatch ? sigMatch[1].trim() : null;

    // 可选：社区沉淀条目（自动总结而来）—— 来源 + 总结时间
    const srcMatch = meta.match(/来源[:：]\s*(https?:\/\/\S+)/);
    const source = srcMatch ? srcMatch[1].trim() : null;
    const timeMatch = meta.match(/总结时间[:：]\s*(.+)/);
    const summarizedAt = timeMatch ? timeMatch[1].trim() : null;

    // 可选：置信度（用户 2026-11-06 定档）——存**可信度百分比**
    //   0-10% 不可信 / 10-40% 低置信度 / 40-60% 中置信度 / 60-90% 高置信度 / 90-100% 可信
    //   （档位说的是**这条答案有多可信**；互动续聊那个「回不回」才是概率，两套别混）
    //   兼容旧写法「完全正确 / 高 / 中 / 低」→ 95 / 75 / 50 / 20
    //   回复时按档位决定口气；不能自动给「可信」，那档只给官方资料和人工确认。
    const confPct = meta.match(/置信度[:：]\s*(\d{1,3})\s*%?/);
    const confLegacy = meta.match(/置信度[:：]\s*(完全正确|高|中|低)/);
    const LEGACY_PCT = { 完全正确: 95, 高: 75, 中: 50, 低: 20 };
    let confidence = confPct ? Math.max(0, Math.min(100, Number(confPct[1]))) : null;
    if (confidence === null && confLegacy) confidence = LEGACY_PCT[confLegacy[1]] ?? null;

    // 可选：语义确认门（2026-11-17）—— 命中后需 LLM 综合语义判断是否真在问本条才选用，防笼统套用
    const semMatch = meta.match(/语义确认[:：]\s*(.+)/);
    const semanticConfirm = semMatch ? /true|是|yes/i.test(semMatch[1]) : false;

    entries.push({
      question,
      keywords,
      version,
      signature,
      source,
      summarizedAt,
      // 没写：人工条目 95（可信，人复核过）/ 社区沉淀 50（中置信度，玩家说法）
      confidence: confidence === null ? (source ? 50 : 95) : confidence,
      confidenceLabel: confLabelOf(confidence === null ? (source ? 50 : 95) : confidence),
      auto: !!source, // 自动沉淀 → 匹配时打折（低于人工条目）
      semanticConfirm,
      answer,
      id: slug(question),
    });
  }
  return entries;
}

/** 置信度百分比 → 档位标签（用户 2026-11-06 定的五档） */
export function confLabelOf(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '中置信度';
  if (n < 10) return '不可信';
  if (n < 40) return '低置信度';
  if (n < 60) return '中置信度';
  if (n < 90) return '高置信度';
  return '可信';
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function normalize(text) {
  return (text || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/**
 * 打分：关键词命中(0.6) + 文本相似(0.4)
 *
 * 排序优先级（对应「优先用多次更新、多次使用、时间较新」的要求）：
 *   - 被引用次数多的 → 权重更高（weightOf 里每次 +0.03，封顶 +0.15）
 *   - 最近被引用过的 → 权重更高（7 天内 +0.05，30 天内 +0.02）
 *   - 人工维护的条目 → 比社区自动沉淀的高（无 source 额外 +0.03；有 source 的 ×0.9）
 *
 * @param opts.vecScore 该条目的**向量相似度**（0~1，来自 lib/qa-vector.mjs）。
 *   相似度项取「旧 bigram dice」与「向量余弦」的**较大者** —— 只加不减，不会让原本能匹配的条目掉下去。
 *   ⚠️ 向量最多只能贡献 0.4 的那部分，**光靠向量永远够不到 autoReplyScore**（阈值 ≥0.6），
 *      所以不会因为向量误召回就自动发一条错答案。
 */
export function scoreEntry(postText, entry, { usage = null, now = Date.now(), vecScore = 0 } = {}) {
  const text = normalize(postText);
  // 相似度只跟「问法」比，不跟关键词拼起来比 ——
  // 把关键词也算进去会把分母撑大，词越多相似度越低（实测过）
  const entryText = normalize(entry.question);

  let hit = 0;
  let total = 0;
  let strength = 0; // 命中强度：长关键词更值钱
  for (const kwRaw of entry.keywords) {
    const kw = normalize(kwRaw);
    if (!kw || kw.length < 2) continue;
    if ([...kw].every((c) => STOP.has(c))) continue;
    total++;
    if (text.includes(kw)) {
      hit++;
      // 「剩下的换什么」(6 字) 命中比「钻石」(2 字) 命中更有说服力
      strength += Math.min(1, kw.length / 4);
    }
  }

  // 关键词得分：**饱和 + 长度加权**，不是取比例。
  // 旧写法 hit/total 有个致命缺陷：关键词写得越多，分数被稀释得越厉害 ——
  // 一条 18 个关键词的条目连自己的原题都只能拿 0.19，等于「越用心越匹配不上」。
  // 现在：累计强度达到 2.0 就算满分（≈两个 4 字词，或 4 个短词）。
  const kwScore = total ? Math.min(1, strength / 2) : 0;

  const sim = dice(bigrams(text), bigrams(entryText));
  // 相似度项：旧 dice 与向量相似度取大者（向量只加分不扣分）
  // 向量上限 0.85：宁可少拿一点分，也别让「语义相近但答的不是这一问」直接冲过自动回复线
  const simTerm = Math.max(Math.min(1, sim * 2.2), Math.min(0.85, (Number(vecScore) || 0) * 3));
  let base = 0.6 * kwScore + 0.4 * simTerm;

  // 社区自动沉淀的条目打折，避免未经人工复核的答案直接触发自动回复
  if (entry.auto) base *= 0.9;

  // 使用频次 + 新鲜度加权
  let weight = 1.0;
  if (usage) {
    const s = usage.items?.[entry.id];
    if (s) {
      weight += Math.min(0.15, (s.cited || 0) * 0.03);
      const last = s.lastCitedAt ? Date.parse(s.lastCitedAt) : 0;
      if (last) {
        const days = (now - last) / 86400000;
        if (days <= 7) weight += 0.05;
        else if (days <= 30) weight += 0.02;
      }
    }
    if (!entry.auto) weight += 0.03;
  }

  const score = Math.min(1, base * weight);
  return { score, base, weight, kwScore, sim, hits: hit, keywordsTotal: total, auto: !!entry.auto };
}

/**
 * 返回 top-N 候选
 * @param opts.vecScores {entryId: 余弦相似度}（可选，来自 lib/qa-vector.mjs）
 */
export function matchPost(postText, entries, topN = 3, opts = {}) {
  const vecScores = opts.vecScores || {};
  const scored = entries
    .filter((e) => !opts.usage?.items?.[e.id]?.archived)
    .map((e) => ({ entry: e, ...scoreEntry(postText, e, { ...opts, vecScore: vecScores[e.id] || 0 }) }))
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/**
 * 是否是「分享 / 记录 / 进度 / 吐槽」类帖子
 *
 * 这类帖不是提问，套答疑内容会答非所问，但可以去说句话（轻互动）。
 * 必须排除掉「兑换码 / 组队 / 招募」这些**不该插话**的类型。
 *
 * 吐槽帖也算在内 —— 但只收**纯情绪吐槽**（离谱/笑死/又崩了/正常操作），
 * 真正要人工处理的投诉（退款/客服/封号/举报/补偿）已被 config.reply.blacklistWords
 * 挡成 manual，走不到这里，可以放心把吐槽纳入。
 */
export function looksLikeShare(text) {
  const t = String(text || '')
    .replace(/\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\]/g, '')
    .trim();
  if (!t) return false;
  // 不该插话的
  if (/(兑换码|激活码|组队|满勤|招募|加群|出售|代打|收号|码\s*[:：]?\s*[A-Za-z0-9]{4,})/.test(t)) return false;
  // 涉及维权/损失的吐槽不去凑热闹（让版主自己判断）——只收纯情绪
  if (/(退款|客服|补偿|封号|举报|充值|消费|损失|维权|申诉|投诉)/.test(t)) return false;
  // 分享 / 记录 / 进度特征
  if (
    /(分享|记录|纪念|进度|终于|打过了|通关|集齐|凑齐|毕业|到手|拿下|肝到|满级|升到|只剩.{0,4}没过|还剩.{0,4}没)/.test(
      t
    )
  ) {
    return true;
  }
  // 纯情绪吐槽特征（跟着共鸣一句，不下判断）
  return /(崩了|闪退|卡死|白给|离谱|笑死|无语|麻了|阴间|正常操作|又又|真的服|蚌埠)/.test(t);
}

/**
 * 是否是「情绪帖」—— 只想有人应一声，没有求解诉求
 *
 * 来历（2026-11-10 用户要求）：《我无疑是绝望的。。。》（任务差一点没完成）、
 * 《我想知道玩这个游戏的...》（被谐音脏话昵称恶心到）。这两条
 * ① 答疑库答不了；② 又没有「终于/到手/集齐」这些分享特征 → `looksLikeShare` 不认；
 * ③ 于是双双掉进「🖐 需人工」，一句话都没有。
 *
 * 判据：**情绪强** + **不涉维权/损失/加好友**。
 * 涉维权的一律不插话 —— 那种帖要版主自己判断，不能给平台表态的机会。
 * 命中只代表「可以过去陪一句」，不代表可以不上报。
 */
export function looksLikeEmotion(text) {
  const t = String(text || '')
    .replace(/\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\]/g, '')
    .trim();
  if (!t) return false;
  // 维权 / 损失 / 账号交易 → 不凑热闹
  if (/(退款|客服|补偿|封号|举报|充值|消费|损失|维权|申诉|投诉|出售|收号|代打)/.test(t)) return false;
  // 加好友 / 兑换码 → 走各自的通道
  if (/(加好友|好友位|好友码|扩列|互加|互赞|JFA[A-Za-z0-9]{7}|(?:and|ios)[A-Za-z0-9]{8})/i.test(t))
    return false;
  // 带**求解诉求**的是真提问，不是纯情绪 —— 让答疑通道处理，别在这儿抢话。
  //   ⚠️ 只认「求解型」疑问词：不能直接用 looksLikeQuestion()，
  //      否则《我想知道玩这个游戏的...》（表面是问句、实质是吐槽）会被误排除。
  if (/(怎么|如何|咋办|怎么办|咋打|咋过|能不能|可不可以|值得|哪个|哪一|多少|求助|大佬|有没有|推荐)/.test(t))
    return false;
  return /(绝望|难受|憋屈|心疼|寒心|破防|崩溃|麻了|不想玩|弃坑|白肝|白玩|可惜|太亏|血亏|气死|恶心|膈应|窝火|想哭|不甘心|就差|差一点|白费)/.test(
    t
  );
}

/**
 * 是否是「问题类」帖子
 *
 * 原则：**尽量回答问题** —— 宁可多判成提问（进「需人工」让版主扫一眼），
 * 也不要漏掉真问题（漏了就是没人回，影响更差）。
 *
 * 判定顺序（先强信号后弱信号）：
 *   1. 明确非提问标记（【攻略】【前瞻】/兑换码/满勤/完成态…）→ 非提问
 *      ← 必须放在疑问词前面：攻略帖正文里常有「怎么打」，先判疑问会误判
 *   2. 明确疑问/求助词 → 提问
 *   3. 其余模糊情况 → **默认当提问**
 *
 * 历史 bug：
 *   - 早期词表只有「为什么」没有「什么」，导致「买了塔黄无尽用什么不较好」漏判
 *   - 早期先判疑问词，导致「【官方攻略】…困难6攻略」（正文含"怎么"）被误判成提问
 */
export function looksLikeQuestion(text) {
  if (!text) return false;
  // 去掉 [表情_xxx] / [TapTap×xxx_yyy] 标记再判
  const t = String(text).replace(/\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\]/g, '').trim();
  if (!t) return false;

  // 1. 明确非提问（强信号，优先）
  //    注意 `码` 规则必须限定在「码」字后面，否则纯数字标题（如「1234567890有人帮一下吗」）
  //    会被当成兑换码误判
  const NOT_ASK =
    /(【\s*官方攻略\s*】|【\s*攻略\s*】|【\s*前瞻\s*】|【\s*福利\s*】|【\s*整活\s*】|【\s*公告\s*】|【\s*情报\s*】|攻略|教程|分享|记录|纪念|吐槽|整活|公告|活动预告|招募|加群|组队|交友|满勤|兑换码|激活码|领取|码\s*[:：]?\s*[A-Za-z0-9]{4,}|https?:\/\/|兑换了|终于|集齐|凑齐|毕业了|打过了|通关了|白嫖到)/;
  if (NOT_ASK.test(t)) return false;

  // 2. 明确疑问 / 求助
  const ASK =
    /(什么|怎么|怎样|咋样|咋办|咋|如何|为什么|为啥|哪个|哪种|哪些|哪关|哪张|哪里|在哪|多少|几个|几天|几次|多长|能不能|可不可以|可以吗|行不行|有没有|有人帮|是否|是不是|会不会|要不要|值不值|值得吗|求推荐|推荐|求问|求教|求助|请问|问一下|大佬|萌新|新手|急|在线等|返场|多久|\?|？)/;
  if (ASK.test(t)) return true;

  // 3. 纯数字 / 纯字母数字 ID（如「1234567890」「abc123456」）→ 非提问
  //    注意：先排除含中文的情况，否则「买了塔黄无尽用什么不较好」会被误杀
  //    多行文本要先去掉换行，否则「iOS\nJFI2xx0eV9」这种兑换码帖会被漏判成提问
  const flat = t.replace(/\s+/g, '');
  if (/^[A-Za-z0-9]+$/.test(flat)) return false;

  // 3b. 兑换码特征：一段 ≥6 位、且**含字母**的纯字母数字串（UID 是纯数字，不算）
  //     「JFI2xx0eV9」「JFAABCDEFG」这类 → 非提问
  //     （纯数字长串如「43****11」不在此列 —— 那可能是一串 UID + 一句求助）
  if (/[A-Za-z]/.test(flat) && /[A-Za-z0-9]{6,}/.test(flat)) return false;

  // 4. 太短又没疑问词 → 多半是「天宫码」「塔黄」这类标题/无效帖
  if (t.length < 6 && !ASK.test(t)) return false;

  // 4b. 「弱非提问」：进度汇报 / 完成记录。
  //     ⚠️ 必须放在 ASK 之后 —— 「只剩9没过了」是分享（无疑问词），
  //        但「只剩9没过，怎么打」是真提问（含"怎么"），不能一刀切。
  //     实测：「只剩9没过了。」曾被默认兜底判成提问，还把内容当问答收进了库。
  const WEAK_NOT_ASK =
    /(只剩.{0,4}没过|还剩.{0,4}没|只差.{0,4}(没|未)|还差.{0,4}(没|未)|就差|没打完|没过完|差.{0,2}关|快了|稳了|到手了)/;
  if (WEAK_NOT_ASK.test(t)) return false;

  // 5. 模糊 → 默认当提问（原则：尽量回答）
  return true;
}
