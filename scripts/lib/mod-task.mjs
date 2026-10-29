// 版主管理任务 · 判定规则：哪些帖属于「加好友」行为
//
// 用户 2026-10-29 明确要求：
//   「将存在"加好友"、"一起玩"、"好友位"等加好友行为，统一回复一下内容。并移除该帖。」
//   补充：这三个词 + 同义词；看标题/正文；**大部分会包含邀请码**。
//
// ⚠️ 移除是不可逆的版主动作，所以判定必须**宁可漏、不可错**：
//   - 命中「排除词」（官方/公告/攻略/招募/兑换码…）→ 一律放过
//   - 「弱特征」（一起玩/找人一起）必须**同时带邀请码**才算 ——
//     否则会把正常的「一起玩困难9」组队帖一起端掉
//   - 只贴一个邀请码、正文没别的 → 也算（现场确实有「and5JSA48WW」这种裸码帖）
//
// 邀请码长什么样：TapTap 的分享码，形如 `and5ZM3TJ2K`（and + 6~12 位字母数字）。

/** 强特征：本身就是「在加好友」 */
export const FRIEND_KEYWORDS_STRONG = [
  '加好友',
  '好友位',
  '好友码',
  '好友群',
  '好友',
  '互加',
  '互关',
  '加群',
  '拉群',
  '加微',
  '加v',
  '加我',
  '邀请码',
  '二维码',
];

/** 弱特征：只有在同时出现邀请码时才算（否则会误伤组队帖） */
export const FRIEND_KEYWORDS_WEAK = ['一起玩', '找人一起', '求一起', '组队一起', '一起玩吧', '一起玩吗'];

/** 正当内容：命中就放过（宁可漏，不可错删） */
export const EXCLUDE_KEYWORDS = [
  '官方',
  '公告',
  '攻略',
  '教程',
  '招募',
  '组队',
  '开黑',
  '缺人',
  '主播',
  '直播',
  '兑换码',
  '天宫码',
  '序列号',
  '激活码',
  '福利码',
  '礼包码',
];

/** TapTap 分享邀请码：and + 6~12 位字母数字 */
export const INVITE_CODE_RE = /\band[A-Za-z0-9]{6,12}\b/g;

/** 整篇只有一个邀请码（裸码帖） */
const ONLY_CODE_RE = /^\s*and[A-Za-z0-9]{6,12}\s*$/;

/**
 * 判定一个帖子是不是「加好友行为」
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.text
 * @returns {{hit:boolean, keyword?:string, inviteCode?:string|null, reason:string}}
 */
export function detectFriendRequest({ title = '', text = '' } = {}) {
  const raw = `${title}\n${text || ''}`;
  const flat = raw.replace(/\s+/g, ' ').trim();

  const ex = EXCLUDE_KEYWORDS.find((w) => flat.includes(w));
  if (ex) return { hit: false, reason: `含正当内容「${ex}」，放过` };

  const codes = flat.match(INVITE_CODE_RE) || [];
  const code = codes[0] || null;

  // 裸码帖：正文只有一个邀请码
  if (!String(title || '').trim() && ONLY_CODE_RE.test(String(text || '').trim())) {
    return { hit: true, keyword: '裸邀请码', inviteCode: code, reason: `整篇只有一个邀请码 ${code}` };
  }

  const strong = FRIEND_KEYWORDS_STRONG.find((w) => flat.includes(w));
  if (strong) {
    return { hit: true, keyword: strong, inviteCode: code, reason: `命中「${strong}」${code ? ` + 邀请码 ${code}` : ''}` };
  }

  const weak = FRIEND_KEYWORDS_WEAK.find((w) => flat.includes(w));
  if (weak) {
    if (code) {
      return { hit: true, keyword: weak, inviteCode: code, reason: `命中「${weak}」且带邀请码 ${code}` };
    }
    return { hit: false, reason: `命中「${weak}」但没有邀请码，可能是正常组队，放过` };
  }

  return { hit: false, reason: code ? `只有邀请码 ${code}，没有加好友特征，放过` : '无加好友特征' };
}

/** 统一回复文案（用户指定；集中贴链接要改就改 config.modTasks.friendRequest.reply） */
export const DEFAULT_FIXED_REPLY =
  '你好呀～好友码集中贴已经置顶啦，单开帖很容易被刷下去反而没人看到。' +
  '麻烦把内容按格式盖到这栋楼 👉 https://www.taptap.cn/moment/864806259805654695，能被更多人找到～';

/** 判定用的关键词全表（测试用） */
export const ALL_KEYWORDS = [...FRIEND_KEYWORDS_STRONG, ...FRIEND_KEYWORDS_WEAK];
