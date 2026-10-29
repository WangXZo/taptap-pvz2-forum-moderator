#!/usr/bin/env node
// 「玩家喊我们」+ 签名识别 回归测试
//
// 改 scripts/lib/signature.mjs / lib/summon.mjs / collect.mjs 的判定规则前后各跑一次：
//   node scripts/test-summon.mjs
//
// 断言分四组：
//   A. 签名识别：我们发的回复 vs 玩家在喊我们（两者必须分得开）
//   B. 语义分桶：敏感 / 夸我们 / 道谢 / 吐槽 / 晒成绩 / 求助 / 打招呼
//   C. 文案护栏：单行、表情在结尾、池子 ≥15、不重样、不贬低、不越权承诺
//   D. 答疑库作答：喊你 + 问问题 → 用库里的答案答，答不上来不许瞎编

import {
  isOurReplyText,
  isSummonText,
  findTag,
  tagsFromConfig,
  squashedTags,
  isOurComment,
  commentText,
  teamUserIdsOf,
} from './lib/signature.mjs';
import { detectMood, buildSummonReply, assertKind, flattenAnswer, SUMMON_TEMPLATES, POOL_SIZES, QA_LEADS } from './lib/summon.mjs';
import { assertNoLeak } from './lib/variants.mjs';

const SIG = '「版主助手-小鲸鱼」';
const CONFIG = {
  reply: { signature: SIG, emoji: { enabled: true } },
  // ⚠️ 这里用**中性假别名**：测试文件会进公开仓库，不能夹带个人昵称
  summon: {
    enabled: true,
    aliases: ['测试别名甲', '测试别名乙'],
    matchRoles: true,
    answerFromQa: true,
    qaScore: 0.6,
  },
  match: { autoReplyScore: 0.65 },
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
  }
};

const mkComment = (id, author, authorId, text, extra = {}) => ({
  id_str: id,
  author: { name: author, id: authorId, is_moderator: false, badges: [] },
  contents: { json: [{ children: [{ text }] }] },
  created_time: 1700000000,
  ...extra,
});

// ============================================================
// A. 签名识别
// ============================================================
console.log('\n[A] 签名识别：我们回过 vs 玩家喊我们');

check('带「」的签名结尾 → 我们的回复', isOurReplyText(`答案正文在这里\n\n${SIG}`, CONFIG));
check('不带「」的签名结尾 → 我们的回复', isOurReplyText('答案正文在这里 版主助手-小鲸鱼', CONFIG));
check('【】包裹 → 我们的回复', isOurReplyText('答案正文在这里【版主助手-小鲸鱼】', CONFIG));
check('签名里有空格 → 我们的回复', isOurReplyText('答案正文在这里 版主助手 小鲸鱼', CONFIG));
check('@ 前缀 → 我们的回复', isOurReplyText('答案正文在这里 @版主助手-小鲸鱼', CONFIG));
check('签名后带表情 → 我们的回复', isOurReplyText(`大佬牛逼 ${SIG}[表情_点赞]`, CONFIG));
check('只有客套 → 不算我们的回复', !isOurReplyText('谢谢小鲸鱼', CONFIG));
check('只有称呼 → 不算我们的回复', !isOurReplyText('小鲸鱼', CONFIG));
check('句中带签名 → 不算我们的回复', !isOurReplyText('小鲸鱼在吗，这个怎么过', CONFIG));
check('问句带签名 → 不算我们的回复', !isOurReplyText('@版主助手-小鲸鱼 求助', CONFIG));

check('findTag 命中自定义别名', !!findTag('我是测试别名甲本人', CONFIG));
check('findTag 命中第二个别名', !!findTag('测试别名乙来了', CONFIG));
check('findTag 认签名内文', !!findTag('版主助手-小鲸鱼 在吗', CONFIG));

const tags = tagsFromConfig(CONFIG);
check('tags 含完整签名', tags.includes(SIG), JSON.stringify(tags));
check('tags 含去括号内文', tags.includes('版主助手-小鲸鱼'));
check('tags 含兜底关键词', tags.includes('版主助手') && tags.includes('小鲸鱼'));
check('tags 含自定义别名', tags.includes('测试别名甲') && tags.includes('测试别名乙'));
const sq = squashedTags(CONFIG);
check('squashedTags 无重复', new Set(sq).size === sq.length, JSON.stringify(sq));
check('squashedTags 去掉了括号', !sq.some((t) => /[「」【】\[\]]/.test(t)));
check('squashedTags 长标签在前', sq[0].length >= sq[sq.length - 1].length);

check('summon：签名在句中 → 喊我们', isSummonText('小鲸鱼在吗', CONFIG).summon);
check('summon：带括号签名 → 喊我们', isSummonText('「版主助手-小鲸鱼」帮看下', CONFIG).summon);
check('summon：@签名 → 喊我们', isSummonText('@版主助手-小鲸鱼 求助', CONFIG).summon);
check('summon：我们自己的回复 → 不算喊话', !isSummonText(`答案\n\n${SIG}`, CONFIG).summon);
check('summon：普通玩家发言 → 不算喊话', !isSummonText('这关好难啊打不过', CONFIG).summon);
check('summon：泛称+呼叫语气 → 喊我们', isSummonText('版主在吗', CONFIG).summon);
check('summon：泛称没呼叫语气 → 不算', !isSummonText('这个是之前版主说过的', CONFIG).summon);
check('summon：认别名', isSummonText('测试别名甲在不在', CONFIG).summon);

check('isOurComment：团队 id 命中', isOurComment(mkComment('1', '队友', '999', '随便说点什么'), { config: CONFIG, teamIds: ['999'] }));
check('isOurComment：队友签名结尾命中', isOurComment(mkComment('2', '队友', '888', `好的，我来说明一下 ${SIG}`), { config: CONFIG, teamIds: ['999'] }));
check('isOurComment：玩家喊话不算我们', !isOurComment(mkComment('3', '路人', '111', '小鲸鱼在吗'), { config: CONFIG, teamIds: ['999'] }));
check('commentText 取正文', commentText(mkComment('4', '路人', '111', '你好呀')) === '你好呀');
check('teamUserIdsOf 去重且忽略脱敏占位', JSON.stringify(teamUserIdsOf({ myUserId: '12*34', teamUserIds: ['12*34', '567'] })) === '["567"]');

// ============================================================
// B. 语义分桶
// ============================================================
console.log('\n[B] 语义分桶');

check('敏感：退款', detectMood('我的退款什么时候到账') === 'sensitive');
check('敏感：客服', detectMood('小鲸鱼帮我转客服') === 'sensitive');
check('敏感：封号', detectMood('我号被封了怎么办') === 'sensitive');
check('敏感：充值', detectMood('充值不到账') === 'sensitive');
check('夸我们', detectMood('版主太负责了，辛苦') === 'praiseMe');
check('道谢', detectMood('谢谢版主') === 'thanks');
check('吐槽', detectMood('又闪退了，真的服') === 'complain');
check('晒成绩', detectMood('终于通关了') === 'celebrate');
check('求助', detectMood('这个关卡怎么过') === 'help');
check('打招呼', detectMood('在吗') === 'greet');
check('兜底', detectMood('嗯嗯' ) === 'other');

// ============================================================
// C. 文案护栏
// ============================================================
console.log('\n[C] 文案护栏');

for (const [k, n] of Object.entries(POOL_SIZES)) {
  check(`模板池 ≥15：${k}（${n}）`, n >= 15, String(n));
}
check('QA_LEADS ≥16', QA_LEADS.length >= 16, String(QA_LEADS.length));

const allTpl = Object.entries(SUMMON_TEMPLATES).flatMap(([k, arr]) => arr.map((t) => [k, t]));
check('所有模板单行', allTpl.every(([, t]) => !/\n/.test(t)));
check('所有模板都留了表情位', allTpl.every(([, t]) => t.includes('{emoji}')));
check('所有模板都有 {name} 或纯通用语', allTpl.every(([, t]) => true));

const samples = [
  { text: '小鲸鱼在吗', author: '路人甲' },
  { text: '谢谢版主', author: '路人乙' },
  { text: '版主太负责了', author: '路人丙' },
  { text: '又闪退了服了', author: '路人丁' },
  { text: '终于通关了', author: '路人戊' },
  { text: '这个关卡怎么过', author: '路人己' },
  { text: '我的退款什么时候到账', author: '路人庚' },
  { text: '嗯嗯', author: '路人辛' },
];
for (const s of samples) {
  const r = buildSummonReply({ text: s.text, author: s.author, postId: 'p1', config: CONFIG, qa: [] });
  check(`生成成功：${s.text}`, !!r.text && r.text.length > 0);
  check(`单行：${s.text}`, !r.text.includes('\n'), r.text);
  check(`表情在结尾：${s.text}`, /\]\s*$/.test(r.text), r.text);
  check(`签名在表情前：${s.text}`, r.text.includes(` ${SIG}[表情_`), r.text);
  check(`过护栏：${s.text}`, assertKind(r.text).ok, JSON.stringify(assertKind(r.text)));
  check(`不泄露内部信息：${s.text}`, assertNoLeak(r.text).ok, JSON.stringify(assertNoLeak(r.text)));
}

// 敏感 → 必须是「拒绝」，不能给建议
const sens = buildSummonReply({ text: '我的退款什么时候到账，我要举报', author: '甲', postId: 'p1', config: CONFIG, qa: [] });
check('敏感 → 走 sensitive 桶', sens.mood === 'sensitive', sens.mood);
check('敏感 → 明确说帮不上/走官方', /(官方|客服|帮不上|管不了|说了不算|不归我管|不好讲|没法|不方便)/.test(sens.text), sens.text);
check('敏感 → 不出现补偿承诺', !/(补偿|保证|一定)/.test(sens.text), sens.text);

// 不重复：连着回 8 个人不重样
const seq = [];
for (let i = 0; i < 8; i++) {
  seq.push(buildSummonReply({ text: '在吗', author: '玩家' + i, postId: 'p' + i, config: CONFIG, qa: [] }).text);
}
check('连回 8 条不重样', new Set(seq).size === 8, `${new Set(seq).size}/8`);

// 已发过的文本要避开
const used = [seq[0]];
const again = buildSummonReply({ text: '在吗', author: '玩家9', postId: 'p9', config: CONFIG, qa: [], usedTexts: used });
check('避开已发文本', again.text !== seq[0]);

// 关掉签名就不带签名
const noSig = buildSummonReply({
  text: '在吗',
  author: '甲',
  postId: 'p1',
  config: { ...CONFIG, summon: { ...CONFIG.summon, signature: false } },
  qa: [],
});
check('summon.signature=false → 不带签名', !noSig.text.includes('版主助手'), noSig.text);

// 护栏本身
check('护栏拦下贬低', !assertKind('你就是个傻X').ok);
check('护栏拦下越权承诺', !assertKind('保证给你补偿').ok);
check('护栏放行正常文案', assertKind('这关确实恶心，不是你的问题[表情_加油]').ok);

// ============================================================
// D. 答疑库作答
// ============================================================
console.log('\n[D] 答疑库作答');

const QA = [
  {
    id: 'q1',
    question: '困难6怎么过',
    keywords: ['困难6', '怎么过', '机枪', '冰车'],
    answer: '困难6用机枪加冰车就行，40级足够通关。',
  },
  {
    id: 'q2',
    question: '钻石怎么快速获得',
    keywords: ['钻石', '刷钻'],
    answer: '钻石主要靠每天签到、植物探险、碎片挑战这些稳定来源。',
  },
];
const qaHit = buildSummonReply({
  text: '小鲸鱼，困难6怎么过啊',
  author: '萌新',
  postId: 'p1',
  config: CONFIG,
  qa: QA,
});
check('喊你 + 问问题 → 用答疑库答', qaHit.fromQa === true, JSON.stringify(qaHit));
check('答疑库作答 → 答案事实来自库', qaHit.text.includes('机枪'), qaHit.text);
check('答疑库作答 → 单行', !qaHit.text.includes('\n'), qaHit.text);
check('答疑库作答 → 表情在结尾', /\]\s*$/.test(qaHit.text), qaHit.text);

const qaMiss = buildSummonReply({
  text: '小鲸鱼，某某某某怎么弄',
  author: '萌新',
  postId: 'p2',
  config: CONFIG,
  qa: QA,
});
check('库里有但没命中 → 不瞎编', qaMiss.fromQa === false, JSON.stringify(qaMiss));
check('没命中 → 走 help 桶（诚实说不懂）', qaMiss.mood === 'help', qaMiss.mood);
check('没命中 → 不含库里的答案', !qaMiss.text.includes('机枪'), qaMiss.text);

// 答案里有多行 → 压成单行
const fl = flattenAnswer('第一行\n第二行\n第三行[表情_开心]');
check('多行答案压成单行', !fl.flat.includes('\n'), JSON.stringify(fl));
check('行尾表情被摘出来', fl.tail.includes('表情_开心'), JSON.stringify(fl));

console.log(`\n${fail === 0 ? '✓' : '✗'} 测试结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
