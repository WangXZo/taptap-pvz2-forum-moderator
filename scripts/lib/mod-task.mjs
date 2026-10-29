// 版主管理任务 · 判定规则：哪些帖**明确在邀请别人加好友**
//
// 用户 2026-10-29 的原话与澄清：
//   「将存在"加好友"、"一起玩"、"好友位"、"扩列"等加好友行为，统一回复一下内容。并移除该帖。」
//   「我发现，你有误识别。请**仅限"存在加好友意图"**」
//   补充（活动报名板）：**十月同游/组队/一起玩 = 游戏内新增好友功能，不是加好友 → 不处理**
//   补充：**活动邀请码（求填邀请码/求互帮）→ 不处理**
//
// 所以判定改成两层：**意图模式**（明确在拉人加好友）命中、且**排除模式**（活动组队/活动邀请码/
// 游戏功能里的「好友」）都没命中 → 才算「加好友意图」。
//
// ⚠️ 排除永远优先于意图 —— 误删一张正常帖比放过几个广告严重得多。
// ⚠️ 移除是不可逆的版主动作，但它是「移出版块」不是删帖（内容仍在、可恢复）。

/**
 * 意图模式：明确在邀请别人加好友
 *
 * 注意：这里**不能**放「好友」这种裸词 —— 「好友宝箱」「好友度」「好友奖励」会全部误伤。
 */
export const INTENT_PATTERNS = [
  /加(个|我|一下|点)?好友/, // 加好友 / 加我好友 / 加个好友
  /快?来加好友/, // 快来加好友
  /好友位/, // 好友位
  /好友码/, // 好友码（TapTap 的 and 码）
  /好友群/,
  /好友邀请/, // ⚠️ 会和「活动里的好友邀请」冲突 → 由排除模式兜住
  /扩列/,
  /互加/, // 互加 / 好友互加
  /互赞好友/,
  /好友互赞/,
  /互关好友/,
  /求好友/,
  /蹭好友/,
  /有人加不/,
  /好友来加我/,
  /加群/,
  /拉群/,
  /加微/,
  /加威信/,
  /加v(?![a-z])/i, // 加V / 加v（别把"adv"这种英文单词吃掉）
];

/**
 * 排除模式：命中就放过
 *
 * 1) 活动组队 / 一起玩 —— 游戏内新增好友功能（用户 2026-10-29 明确：不算）
 * 2) 活动邀请码互填 —— 活动机制，不是加好友
 * 3) 游戏功能里的「好友」—— 好友宝箱 / 好友度 / 好友奖励 …
 */
export const EXCLUDE_PATTERNS = [
  // ① 活动组队 / 一起玩
  /一起玩|一起做|一起同游|组队|组小队|同游|做任务|来进队吗|缺人|开黑|招募|求组队|有大神带|来个人一起/,
  // ② 活动邀请码互填
  /邀请码|互填|填一下|求互帮|求互填|义父|球球了|求求了|跪求|帮帮忙|帮忙填|新人互助|互相帮助|帮一下/,
  // ③ 游戏功能里的「好友」
  /好友(宝箱|度|奖励|系统|商店|积分|等级|解锁|礼包|福利|回馈|排行|挑战|助力|活动|任务|特权|权限)/,
  // ④ 正当内容
  /官方|公告|攻略|教程|版本更新|主播|直播|反馈/,
];

/** 标题整体就是好友类词（例：标题只有一个「好友」） */
export const FRIEND_ONLY_TITLE_RE =
  /^(好友|加好友|互加|互赞|扩列|好友位|好友码|好友群|加个好友|求好友|蹭好友|好友邀请|来加好友|加我好友)$/;

/** TapTap 分享码：and + 6~12 位字母数字（好友码就长这样） */
export const INVITE_CODE_RE = /\band[A-Za-z0-9]{6,12}\b/g;

/** 整篇只有一个邀请码（裸码帖） */
const ONLY_CODE_RE = /^\s*and[A-Za-z0-9]{6,12}\s*$/;

/**
 * 判定一个帖子是不是「加好友意图」
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.text
 * @param {boolean} [o.bareCodeIsIntent] 裸邀请码帖算不算（默认算）
 * @returns {{hit:boolean, keyword?:string, inviteCode?:string|null, reason:string}}
 */
export function detectFriendRequest({ title = '', text = '', bareCodeIsIntent = true } = {}) {
  const t = String(title || '').trim();
  const body = String(text || '');
  const flat = `${t}\n${body}`.replace(/\s+/g, ' ').trim();

  // ① 排除优先
  const ex = EXCLUDE_PATTERNS.find((re) => re.test(flat));
  if (ex) {
    const m = flat.match(ex);
    return { hit: false, reason: `含「${m?.[0] ?? ex.source}」（活动组队/活动邀请码/游戏功能），不是加好友` };
  }

  // ② 意图模式
  const intent = INTENT_PATTERNS.find((re) => re.test(flat));
  if (intent) {
    const m = flat.match(intent);
    const code = (flat.match(INVITE_CODE_RE) || [])[0] || null;
    return {
      hit: true,
      keyword: m?.[0] ?? intent.source,
      inviteCode: code,
      reason: `加好友意图「${m?.[0] ?? intent.source}」${code ? ` + 邀请码 ${code}` : ''}`,
    };
  }

  // ③ 标题整体就是好友类词
  if (t && FRIEND_ONLY_TITLE_RE.test(t)) {
    const code = (flat.match(INVITE_CODE_RE) || [])[0] || null;
    return { hit: true, keyword: t, inviteCode: code, reason: `标题就是「${t}」` };
  }

  // ④ 裸邀请码帖（整篇只有一个 and 码 —— 那就是好友码分享）
  const code = (flat.match(INVITE_CODE_RE) || [])[0] || null;
  if (bareCodeIsIntent && !t && ONLY_CODE_RE.test(body.trim())) {
    return { hit: true, keyword: '裸邀请码', inviteCode: code, reason: `整篇只有一个好友码 ${code}` };
  }

  // ⑤ 只有邀请码但还有别的字 → 看有没有「好友」类词
  if (code && /好友|扩列|互加|互赞/.test(flat)) {
    return { hit: true, keyword: '好友码', inviteCode: code, reason: `含好友码 ${code}` };
  }

  return { hit: false, reason: code ? `只有活动邀请码 ${code}，没有加好友意图` : '没有加好友意图' };
}

/**
 * 帖子作者是不是**官方/版主**（这类帖一律不动）
 *
 * 用户 2026-10-29：「所有检查"好友意图"应跳过，有"官方版主"标识的帖」
 *
 * 现场实测（feed 接口）：玩家帖 `author.user.is_moderator === false`、`moderator_type === 0`；
 * 官方号（如「拓维游戏」带「官方版主 / 《植物大战僵尸2》官方」标识）会是 true / 非 0。
 * 判定放宽一点：**只要像官方/版主就跳过** —— 宁可放过，不可误删官方公告。
 *
 * @param {object} moment  feed 里的 item.moment
 * @returns {{official:boolean, reason?:string}}
 */
export function checkAuthor(moment, { myUserId = '' } = {}) {
  const u = moment?.author?.user || moment?.author || {};
  const uid = String(u.id || '');
  const name = String(u.name || '');

  if (myUserId && uid && uid === String(myUserId)) {
    return { official: true, reason: '这是我们自己的帖，不动' };
  }
  if (u.is_moderator === true) {
    return { official: true, reason: `作者是版主（is_moderator）${name ? `「${name}」` : ''}` };
  }
  if (Number(u.moderator_type || 0) > 0) {
    return { official: true, reason: `作者是官方/版主（moderator_type=${u.moderator_type}）${name ? `「${name}」` : ''}` };
  }
  // 兜底：名字里带官方/版主字样（接口字段将来变了也能挡住）
  if (/官方|版主|管理组|答疑组|运营/.test(name)) {
    return { official: true, reason: `作者名带官方/版主字样「${name}」` };
  }
  return { official: false };
}

/** 统一回复文案（用户指定；集中贴链接要改就改 config.modTasks.friendRequest.reply） */
export const DEFAULT_FIXED_REPLY =
  '你好呀～好友码集中贴已经置顶啦，单开帖很容易被刷下去反而没人看到。' +
  '麻烦把内容按格式盖到这栋楼 👉 https://www.taptap.cn/moment/864806259805654695，能被更多人找到～';

/** 判定用的关键词全表（测试用） */
export const ALL_KEYWORDS = INTENT_PATTERNS.map((re) => re.source);

/**
 * 今天 00:00 的时间戳（秒）
 *
 * 「今天」按**本机时区**算 —— 论坛运营时间也是本地时间。
 * 「加好友」功能是今天上线的，所以只处理今天及以后的，历史帖一律不碰。
 */
export function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 今天的日期串（用于判断游标是不是昨天的） */
export function todayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(now);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
