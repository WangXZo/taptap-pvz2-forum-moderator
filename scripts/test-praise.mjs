#!/usr/bin/env node
// 夸奖逻辑回归测试（31 条断言）
//
// 改 scripts/lib/praise.mjs 或 summarize.mjs 的 isUsefulAnswer 前后各跑一次：
//   node scripts/test-praise.mjs
//
// 含一组**口吻护栏**：「没有客服腔」「每条都点名」「够短」「说法够散」—— 
// 因为第一版文案是客服腔，被用户打回过。

import { pickPraiseTarget, composePraise, pickEmoji, PRAISE_TEMPLATES } from './lib/praise.mjs';

const SIG = '「版主助手-小鲸鱼」';

const mk = (id, author, authorId, text, extra = {}) => ({
  id_str: id,
  author: { name: author, id: authorId, is_moderator: false, badges: [] },
  contents: { json: [{ children: [{ text }] }] },
  created_time: 1700000000,
  ups: 0,
  child_posts: extra.child || [],
  ...extra,
});

const comments = [
  mk('1', '路人甲', '111', '顶'),
  mk('2', '老玩家A', '222', '打法是先放向日葵再放豌豆，困难6用机枪就能过，40级足够', { ups: 6 }),
  mk('3', '版主B', '333', '官方提示：注意活动结束时间', {
    author: { name: '版主B', id: '333', is_moderator: true, badges: ['答疑智多星'] },
  }),
];

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

console.log('== pickPraiseTarget ==');
const t = pickPraiseTarget(comments, { myUserId: '999' });
check('选中了有效回答', !!t, JSON.stringify(t));
check('不是噪音（顶）', t && !/顶/.test(t.text));
check('不是版主', t && t.author !== '版主B', t?.author);
check('挂在一级评论上', t && !!t.targetCommentId, t?.targetCommentId);
check('作者是内容最具体的那位', t && t.author === '老玩家A', t?.author);

const t2 = pickPraiseTarget(comments, { myUserId: '222' });
check('只我答过 → 不夸自己（无目标）', t2 === null, JSON.stringify(t2));

console.log('\n== 无效回答要被挡掉 ==');
const junk = [
  mk('10', '甲', '901', '谢了兄弟下个月找我'),
  mk('11', '乙', '902', '如果不行就找客服'),
  mk('12', '丙', '903', '你是不是没有更新？'),
  mk('13', '丁', '904', '不是氪这么多'),
  mk('14', '戊', '905', '天宫码 JFA6Ds3Jcl'),
];
check('全是无效回答 → 不夸', pickPraiseTarget(junk, { myUserId: '999' }) === null, JSON.stringify(pickPraiseTarget(junk, { myUserId: '999' })));

console.log('\n== 楼中楼回答 → 挂父评论 ==');
const nested = [
  mk('20', '楼主', '1', '求助：这关怎么过', {
    child: [mk('21', '热心人C', '444', '困难6用机枪加冰车就行，我40级通关了')],
  }),
];
const t3 = pickPraiseTarget(nested, { myUserId: '999' });
check('楼中楼回答挂到父评论 id=20', t3 && t3.targetCommentId === '20', JSON.stringify(t3?.targetCommentId));
check('isNested 标记正确', t3 && t3.isNested === true);

console.log('\n== composePraise ==');
const p = composePraise({ author: '老玩家A', replyText: '打法是先放向日葵再放豌豆，困难6用机枪就能过', signature: '「版主助手-小鲸鱼」' });
console.log('  ' + p.text);
check('带 1 个表情标记', (p.text.match(/\[表情_.+\]/g) || []).length === 1, p.text);
check('带签名', p.text.includes('「版主助手-小鲸鱼」'));
check('含玩家昵称', p.text.includes('老玩家A'));
check('文案是单行（楼中楼 fill 多行会失败）', !p.text.includes('\n'), JSON.stringify(p.text));
check('表情在结尾', /\]\s*$/.test(p.text), JSON.stringify(p.text));
const pNoSig = composePraise({ author: '老玩家A', replyText: '可以的' });
check('无签名时也单行且表情结尾', !pNoSig.text.includes('\n') && /\]\s*$/.test(pNoSig.text), JSON.stringify(pNoSig.text));

console.log('\n== pickEmoji ==');
check('长+数字 → 点赞', pickEmoji('打法是先放向日葵再放豌豆，困难6用机枪就能过，40级足够') === '点赞');
check('教学口吻 → 比心', pickEmoji('建议先升阶再打，注意资源分配') === '比心');
check('简短 → 开心', pickEmoji('可以的') === '开心');

// ============================================================
// 口吻回归：口语化 / 亲切 / 多样
//
// 背景：第一版文案是『感谢 {name} 的热心解答，讲得很清楚，帮到不少人』，
//       被用户打回：「像客服回访，一眼机器人」。这一组断言就是那道护栏。
// 用户给的标杆：「哇~XX大佬，牛逼」「大佬，好肝啊！」「大佬，肝肝还好吗？」
// ============================================================
console.log('\n== 口吻：口语化 ==');
const OFFICE =
  /(感谢.{0,8}(热心解答|耐心解答)|讲得很清楚|帮到不少人|正是新手需要的那种答案|尊敬的|您好|感谢您的|请知悉)/;
const office = PRAISE_TEMPLATES.filter((t) => OFFICE.test(t));
check('没有客服腔', office.length === 0, JSON.stringify(office));

const HUMAN = /(大佬|哇|啊|服|牛|稳|好家伙|顶|靠谱|了)/;
check('每条都有口语特征', PRAISE_TEMPLATES.every((t) => HUMAN.test(t)));

const noName = PRAISE_TEMPLATES.filter((t) => !t.includes('{name}'));
check('每条都点名（楼中楼不点名不知道夸谁）', noName.length === 0, JSON.stringify(noName));

const tooLong = PRAISE_TEMPLATES.filter((t) => t.replace(/\{name\}/g, '').length > 20);
check('每条都够短（≤20 字，减去昵称）', tooLong.length === 0, JSON.stringify(tooLong));

console.log('\n== 口吻：多样 ==');
check(
  `模板池 ≥15 套（实际 ${PRAISE_TEMPLATES.length}）`,
  PRAISE_TEMPLATES.length >= 15,
  String(PRAISE_TEMPLATES.length)
);
check('模板没有重复', new Set(PRAISE_TEMPLATES).size === PRAISE_TEMPLATES.length);

const said = new Set();
for (let i = 0; i < 30; i++) {
  said.add(composePraise({ author: '玩家' + i, replyText: '困难6用机枪就能过，40级足够' }).text);
}
check('30 个玩家 → 至少 10 种说法', said.size >= 10, `${said.size} 种`);

const b1 = composePraise({ author: '老玩家A', replyText: '困难6用机枪加冰车' }).text;
const b2 = composePraise({ author: '老玩家A', replyText: '困难6用机枪加冰车' }).text;
check('同一人同一条回答措辞稳定（不会来回跳）', b1 === b2, `${b1} | ${b2}`);

const b3 = composePraise({ author: '老玩家A', replyText: '困难6用机枪加冰车', usedTexts: [b1] }).text;
check('避开已发过的夸奖文案', b1 !== b3, `${b1} | ${b3}`);

const v1 = composePraise({ author: '老玩家A', replyText: '先放向日葵再放豌豆，困难6用机枪' }).text;
const v2 = composePraise({ author: '老玩家A', replyText: '钻石靠签到和植物探险攒' }).text;
check('同一个人不同回答 → 换说法', v1 !== v2, `${v1} | ${v2}`);

// 玩家会翻主页：连着夸 8 个人，口气不能重样
const streak = [];
const sent = [];
for (let i = 0; i < 8; i++) {
  const r = composePraise({
    author: '玩家' + i,
    replyText: '困难6用机枪加冰车就行，我40级通关了',
    usedTexts: sent,
  });
  streak.push(r.template);
  sent.push(r.text);
}
check('连夸 8 人 → 8 种不同口气', new Set(streak).size === 8, `${new Set(streak).size} 种`);

console.log('\n== 格式硬约束（改模板不能破坏）==');
const rendered = [];
for (let i = 0; i < 40; i++) {
  rendered.push(
    composePraise({ author: '玩家' + i, replyText: '困难6用机枪就能过，40级足够', signature: SIG }).text
  );
}
check('全部单行（楼中楼 fill 多行会清空）', rendered.every((t) => !t.includes('\n')));
check('全部恰好 1 个表情', rendered.every((t) => (t.match(/\[表情_[^\]]+\]/g) || []).length === 1), rendered[0]);
check('表情都在结尾', rendered.every((t) => /\]$/.test(t)), rendered[0]);
check('都带签名', rendered.every((t) => t.includes(SIG)));
check('表情都是标准组内的名字', rendered.every((t) => /\[表情_(点赞|比心|星星眼|开心)\]$/.test(t)));

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
