#!/usr/bin/env node
// 互动续聊回归测试（用户 2026-11-05）
//
// 覆盖：纯客套识别 / 情绪强烈例外 / 候选挑选（@你·回复你·喊你）/ 降概率 / 回复位置 / 计数
// 纯离线，不联网、不碰状态库。

import {
  isPureThanks,
  isStrongSignal,
  pickInteractions,
  decideInteraction,
  replyTargetFor,
  bumpCount,
  playerKey,
  latestReplyState,
} from './lib/interact.mjs';

let ok = 0;
let fail = 0;
function t(name, cond) {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const CONFIG = {
  reply: { signature: '「版主助手-小鲸鱼」' },
  summon: { aliases: ['大肥鱼', '吃白米饭的'], matchRoles: true },
  interact: { samePlayerLimit: 1, probabilityAfterLimit: 0.5, strongTextLen: 40 },
};

/** 造一条评论 */
function cm(id, name, text, uid) {
  return {
    id_str: id,
    author: { name, id: uid || `u_${name}` },
    created_time: 1700000000,
    contents: { json: [{ text }] },
  };
}

// ---------- 1. 纯客套：「哈哈谢谢」不用回 ----------
t('「哈哈谢谢」是纯客套', isPureThanks('哈哈谢谢'));
t('「谢谢大佬」是纯客套', isPureThanks('谢谢大佬'));
t('「牛！」是纯客套', isPureThanks('牛！'));
t('「哈哈哈哈」是纯客套', isPureThanks('哈哈哈哈'));
t('空文本算纯客套', isPureThanks(''));
t('「谢谢大佬，顺便问一下困难6怎么过」不是纯客套', !isPureThanks('谢谢大佬，顺便问一下困难6怎么过'));
t('「我按你说的试了，还是打不过」不是纯客套', !isPureThanks('我按你说的试了，还是打不过'));
t('长句不是纯客套', !isPureThanks('我按你说的方法试了一遍，控住之后输出确实稳了，谢谢大佬'));

// ---------- 2. 情绪强烈 → 必回 ----------
t('直接 @我们 → 必回', isStrongSignal('在吗', { atUs: true }));
t('长文本 → 必回', isStrongSignal('x'.repeat(45), {}));
t('连续追问 → 必回', isStrongSignal('在吗', { followUps: 2 }));
t('情绪激动 → 必回', isStrongSignal('在线等，急死了', {}));
t('普通一句 → 不必回', !isStrongSignal('牛啊', {}));

// ---------- 3. 候选：@你 / 回复你 / 喊你 ----------
const FLAT = [
  { c: cm('C2', '路人甲', '随便聊聊'), parentId: null }, // 普通闲聊 → 不命中
  { c: cm('C3', '路人乙', '哈哈谢谢'), parentId: 'C1' }, // 纯客套 → 不命中
  { c: cm('C4', '路人丙', '大佬牛！'), parentId: 'C1' }, // 回复我们但纯客套 → 不命中
  { c: cm('C5', '小明', '我按你说的试了，还是打不过'), parentId: 'C1' }, // 回复了你 → 命中
  { c: cm('C6', '小红', '@版主助手-小鲸鱼 在吗'), parentId: null }, // @你 → 命中
  { c: cm('C7', '小强', '大肥鱼出来一下'), parentId: null }, // 喊你（别名）→ 命中
];
const OURS = new Set(['C1']);

let picked = pickInteractions(FLAT, { config: CONFIG, ourCommentIds: OURS, prev: {} });
const ids = picked.map((p) => p.commentId).sort();
t('候选共 3 条', picked.length === 3);
t('命中「回复了你」', picked.some((p) => p.commentId === 'C5' && p.why === '回复了你'));
t('命中「@你」', picked.some((p) => p.commentId === 'C6'));
t('命中「喊你（别名）」', picked.some((p) => p.commentId === 'C7'));
t('普通闲聊不命中', !ids.includes('C2'));
t('纯客套不命中', !ids.includes('C3') && !ids.includes('C4'));
t('候选带层级', picked.find((p) => p.commentId === 'C5')?.level === 2);
t('一级回复的层级是 1', picked.find((p) => p.commentId === 'C6')?.level === 1);

// 已回过的不再回
picked = pickInteractions(FLAT, { config: CONFIG, ourCommentIds: OURS, prev: { interactReplied: ['C5'] } });
t('已回应过的不再命中', !picked.some((p) => p.commentId === 'C5'));
// 喊话通道回过的不重复
picked = pickInteractions(FLAT, { config: CONFIG, ourCommentIds: OURS, prev: { summonReplied: ['C6'] } });
t('喊话通道回过的不重复', !picked.some((p) => p.commentId === 'C6'));

// ---------- 4. 降概率：同帖 × 同玩家累计 3 次后 50% ----------
const cand = { commentId: 'C5', parentId: 'C1', level: 2, author: '小明', authorId: 'u_x', text: '我按你说的试了，还是打不过', atUs: false };
t('没回过 → 直接回', decideInteraction(cand, { counts: {}, config: CONFIG }).reply === true);
t('回过 0 次（还没回过）→ 直接回', decideInteraction(cand, { counts: { u_x: { n: 0 } }, config: CONFIG }).reply === true);
t(
  '回过 1 次 → 概率 50%（掷出 0.9 → 不回）',
  decideInteraction(cand, { counts: { u_x: { n: 1 } }, config: CONFIG, rng: () => 0.9 }).reply === false
);
t(
  '回过 1 次 → 概率 50%（掷出 0.1 → 回）',
  decideInteraction(cand, { counts: { u_x: { n: 3 } }, config: CONFIG, rng: () => 0.1 }).reply === true
);
t(
  '回过 1 次 + 直接 @我们 → 例外必回',
  decideInteraction(cand, { counts: { u_x: { n: 3 } }, config: CONFIG, rng: () => 0.99, ...{} }).reply !== undefined &&
    decideInteraction({ ...cand, atUs: true }, { counts: { u_x: { n: 3 } }, config: CONFIG, rng: () => 0.99 }).reply === true
);
t(
  '回过 1 次 + 情绪激动 → 例外必回',
  decideInteraction({ ...cand, text: '在线等，急死了' }, { counts: { u_x: { n: 3 } }, config: CONFIG, rng: () => 0.99 })
    .reply === true
);
t(
  '回过 1 次 + 连续追问 → 例外必回',
  decideInteraction(cand, { counts: { u_x: { n: 3 } }, config: CONFIG, rng: () => 0.99, followUps: 2 }).reply === true
);
t('计数键优先用 user id', playerKey({ authorId: 'u_x', author: '小明' }) === 'u_x');

// ---------- 5. 回复位置（用户 2026-11-05 原话） ----------
const t1 = replyTargetFor({ commentId: 'C9', parentId: null, level: 1, author: '路人' });
t('贴内回复 → 发在它的楼中楼下', t1.mode === 'nested' && t1.parentId === 'C9' && t1.mention === '');
const t2 = replyTargetFor({ commentId: 'C10', parentId: 'C9', level: 2, author: '小明' });
t('本身是楼中楼 → 同层楼中楼', t2.mode === 'nested' && t2.parentId === 'C9');
t('同层回复要 @ 对方', t2.mention === '小明');

// ---------- 6. 计数累加 ----------
let c = bumpCount({}, 'u_x');
t('计数从 1 开始', c.u_x.n === 1);
c = bumpCount(c, 'u_x');
t('计数累加到 2', c.u_x.n === 2);
t('不影响别的键', bumpCount(c, 'u_y').u_y.n === 1);


// ---------- 帖级门控：最新回复是不是我们自己人（2026-11-26 大哥规则） ----------
const CFG = { reply: { signature: '版主助手-小鲸鱼' }, myUserId: '10000001', teamUserIds: ['10000002'] };
const TEAM = ['10000001', '10000002'];

// 构造评论：我们签名结尾 = 自己人
const ours = (id, t = 100) => ({ id_str: String(id), created_time: t, author: { id: 10000001, name: '小鲸鱼' }, contents: { json: [{ text: `就这样办吧 「版主助手-小鲸鱼」` }] } });
const mate = (id, t = 100) => ({ id_str: String(id), created_time: t, author: { id: 10000002, name: '队友' }, contents: { json: [{ text: `这样做就行 「版主助手-小鲸鱼」` }] } });
const player = (id, text = '那小鲸鱼这个怎么弄', t = 100) => ({ id_str: String(id), created_time: t, author: { id: 9999, name: '玩家甲' }, contents: { json: [{ text }] } });

// A. 最新回复是我们 → 不回
let st = latestReplyState([{ c: player(1, '@版主助手-小鲸鱼 求助', 100), parentId: null }, { c: ours(2, 200), parentId: null }], { config: CFG, teamIds: TEAM });
t('最新回复是自己 → ours=true', st.ours === true);
t('最新回复是自己 → 带说明', st.why.includes('我们'));

// B. 最新回复是队友（靠签名认出，id 在 teamUserIds 里）→ 不回
st = latestReplyState([{ c: player(1, '求助', 100), parentId: null }, { c: mate(3, 300), parentId: null }], { config: CFG, teamIds: TEAM });
t('最新回复是队友 → ours=true', st.ours === true);

// C. 队友的 id 不在 teamUserIds，但签名在结尾 → 靠签名也能认出来（多人协作的关键）
st = latestReplyState([{ c: player(1, '求助', 100), parentId: null }, { c: { id_str: '4', created_time: 300, author: { id: 88888, name: '陌生队友' }, contents: { json: [{ text: '答：这样做 「版主助手-小鲸鱼」' }] } }, parentId: null }], { config: CFG, teamIds: TEAM });
t('未知 id 但带签名 → ours=true', st.ours === true);

// D. 最新回复是玩家 → 可以回
st = latestReplyState([{ c: ours(2, 100), parentId: null }, { c: player(5, '那我再问一句', 400), parentId: null }], { config: CFG, teamIds: TEAM });
t('最新回复是玩家 → ours=false', st.ours === false);
t('最新回复是玩家 → 带作者名', st.author === '玩家甲');

// E. 玩家在喊我们（签名在句中）≠ 我们回过 → 仍可回
st = latestReplyState([{ c: player(6, '小鲸鱼在吗，这个关怎么过', 500), parentId: null }], { config: CFG, teamIds: TEAM });
t('玩家喊我们不算自己人 → ours=false', st.ours === false);

// F. 子回复也算（最新的是子回复）
st = latestReplyState([{ c: player(7, '求助', 100), parentId: null }, { c: ours(8, 600), parentId: '7' }], { config: CFG, teamIds: TEAM });
t('最新是子回复且是自己 → ours=true', st.ours === true);

// G. 空列表
st = latestReplyState([], { config: CFG, teamIds: TEAM });
t('无评论 → why=no-comments', st.why === 'no-comments' && st.ours === false);

// H. 按时间取最新（不按数组顺序）
st = latestReplyState([{ c: ours(9, 900), parentId: null }, { c: player(10, '后来的', 1000), parentId: null }], { config: CFG, teamIds: TEAM });
t('按 created_time 取最新', st.ours === false && st.time === 1000);
// I. 边界：队友只回「同上 + 签名」→ 签名判定把「同上」当纯客套，认不出；靠 id 兜底
const thanksMate = { id_str: '11', created_time: 700, author: { id: 10000002, name: '队友' }, contents: { json: [{ text: '同上 「版主助手-小鲸鱼」' }] } };
st = latestReplyState([{ c: player(12, '求助', 100), parentId: null }, { c: thanksMate, parentId: null }], { config: CFG, teamIds: TEAM });
t('纯客套+签名的队友回复，靠 id 认得出', st.ours === true);
// 若 id 也没配（陌生队友）→ 认不出（已知边界，缓解办法：把队友好 id 加进 teamUserIds）
st = latestReplyState([{ c: player(12, '求助', 100), parentId: null }, { c: { ...thanksMate, author: { id: 77777, name: '陌生队友' } }, parentId: null }], { config: CFG, teamIds: TEAM });
t('纯客套+签名且 id 未知 → 认不出（已知边界）', st.ours === false);
console.log(`通过 ${ok} 条`);
if (fail) {
  console.log(`失败 ${fail} 条`);
  process.exit(1);
}
console.log('全部通过 ✓');
