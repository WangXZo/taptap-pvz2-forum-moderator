#!/usr/bin/env node
// 冷热分离回归测试（2026-11-02）
//
// 盯四件事：
//   1) 分类：帖子分到对的类别（自己的帖 / 加好友 / 官方 / 分享 / 提问 / 闲聊）
//   2) TTL：按类别分别设置，各类别用自己的天数
//   3) 冷藏：凉够天数才搬进冷库（带向量）；没凉够的不动
//   4) 唤醒：
//      · 自己的帖 → 有人回（含楼中楼）就唤醒
//      · 别人的帖 → 只有 @我 或 呼唤我才唤醒（普通闲聊不算）

import { DatabaseSync } from 'node:sqlite';
import {
  classifyPost,
  coldTtlDays,
  coldStats,
  isCold,
  putCold,
  archiveToCold,
  shouldWake,
  wakeUp,
  wakeByNotifications,
  searchCold,
  CATEGORIES,
} from './lib/cold-store.mjs';
import { parseNotification, isAboutMe } from './lib/notify.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

const DAY = 86400000;
const NOW = Date.now();

function openTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE post_cold (
      id TEXT PRIMARY KEY, url TEXT, title TEXT, author TEXT, author_id TEXT, board TEXT,
      publish_time INTEGER, category TEXT, qa_status TEXT, status TEXT, keyword TEXT,
      text TEXT, vec TEXT, comment_count INTEGER, last_interaction_at INTEGER,
      cold_at INTEGER, woken_at INTEGER, wake_reason TEXT
    );
  `);
  return db;
}

// ---------- 1) 分类 ----------
const cfg = { myUserId: '999', archive: { coldDays: { mine: 60, friend: 3, official: 180, share: 90, question: 30, chat: 45 } } };
ok('自己的帖 → mine', classifyPost({ authorId: '999', title: '随便写写' }, { config: cfg }) === 'mine');
ok('加好友帖 → friend', classifyPost({ title: '来加好友呀' }, { config: cfg }) === 'friend');
ok('官方帖 → official', classifyPost({ title: '官方公告：版本更新' }, { config: cfg }) === 'official');
ok('分享帖 → share', classifyPost({ title: '分享我的通关阵容', text: '来抄作业' }, { config: cfg }) === 'share');
ok('提问帖 → question', classifyPost({ title: '困难6怎么过', text: '求助' }, { config: cfg }) === 'question');
ok('闲聊帖 → chat', classifyPost({ title: '今天好热', text: '随便聊聊' }, { config: cfg }) === 'chat');

// ---------- 2) TTL 按类别 ----------
ok('friend TTL = 3 天', coldTtlDays('friend', cfg) === 3);
ok('official TTL = 180 天', coldTtlDays('official', cfg) === 180);
ok('question TTL = 30 天', coldTtlDays('question', cfg) === 30);
ok('mine TTL = 60 天', coldTtlDays('mine', cfg) === 60);
ok('没配的类别用默认值', coldTtlDays('chat', { archive: {} }) === CATEGORIES.chat.coldDays);
ok('配置里没写的类别也有默认值', coldTtlDays('unknown-cat', {}) > 0);

// ---------- 3) 冷藏：凉够才搬 ----------
{
  const db = openTestDb();
  const state = {
    posts: {
      old1: { status: 'replied', title: '加好友广告', publishTime: NOW - 10 * DAY, commentCount: 0 },
      fresh1: { status: 'replied', title: '加好友广告2', publishTime: NOW - 1 * DAY, commentCount: 0 },
      pending1: { status: 'pending', title: '还没回', publishTime: NOW - 100 * DAY, commentCount: 0 },
      manual1: { status: 'manual', title: '需人工', publishTime: NOW - 100 * DAY, commentCount: 0 },
    },
  };
  const res = archiveToCold(state, db, { config: cfg, now: NOW });
  ok('凉的被搬进冷库', res.moved === 1, JSON.stringify(res));
  ok('没凉的留在热数据', !!state.posts.fresh1);
  ok('待回复的不搬', !!state.posts.pending1);
  ok('需人工的不搬', !!state.posts.manual1);
  ok('搬走后从热数据移除', !state.posts.old1);
  ok('冷库统计 = 1', coldStats(db).total === 1);
  ok('isCold 认得', isCold(db, 'old1'));
  ok('冷帖带向量（可检索）', searchCold(db, '加好友').length > 0, JSON.stringify(searchCold(db, '加好友')));
}

// ---------- 4) 唤醒：自己的帖 ----------
{
  const coldRow = { id: 'm1', author_id: '999', comment_count: 2 };
  const r1 = shouldWake({ coldRow, comments: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], config: cfg });
  ok('我的帖有人回 → 唤醒', r1.wake === true, JSON.stringify(r1));

  const r2 = shouldWake({ coldRow, comments: [{ text: 'a' }, { text: 'b' }], config: cfg });
  ok('我的帖没人回 → 不唤醒', r2.wake === false, JSON.stringify(r2));
}

// ---------- 5) 唤醒：别人的帖 ----------
{
  const coldRow = { id: 'x1', author_id: '888', comment_count: 1 };
  const isSummon = (text) => /小鲸鱼|大肥鱼/.test(text);
  const isOurComment = () => false;

  const at = shouldWake({
    coldRow,
    comments: [{ text: '@版主助手-小鲸鱼 这个怎么处理' }],
    config: cfg,
    isSummon,
    isOurComment,
  });
  ok('别人@我 → 唤醒', at.wake === true, JSON.stringify(at));

  const call = shouldWake({
    coldRow,
    comments: [{ text: '大肥鱼！！！出来道歉' }],
    config: cfg,
    isSummon,
    isOurComment,
  });
  ok('别人呼唤我 → 唤醒', call.wake === true, JSON.stringify(call));

  const chat = shouldWake({
    coldRow,
    comments: [{ text: '我也卡在这一关' }],
    config: cfg,
    isSummon,
    isOurComment,
  });
  ok('别人普通闲聊 → 不唤醒', chat.wake === false, JSON.stringify(chat));

  const ours = shouldWake({
    coldRow,
    comments: [{ text: '大肥鱼在吗' }],
    config: cfg,
    isSummon,
    isOurComment: () => true,
  });
  ok('我们自己发的 → 不算「唤醒我」', ours.wake === false, JSON.stringify(ours));
}

// ---------- 6) wakeUp 搬回热数据 ----------
{
  const db = openTestDb();
  putCold(db, { id: 'w1', title: '冷帖', author: '路人', authorId: '888' }, {
    category: 'question',
    text: '困难6怎么过',
    commentCount: 1,
    lastInteractionAt: NOW - 100 * DAY,
    now: NOW,
  });
  const state = { posts: {} };
  const res = wakeUp(
    db,
    state,
    [{ id: 'w1', comments: [{ text: '大肥鱼来看看' }] }],
    { config: cfg, isSummon: (t) => /大肥鱼/.test(t), isOurComment: () => false }
  );
  ok('wakeUp 报告唤醒了 1 条', res.woken === 1, JSON.stringify(res));
  ok('冷帖搬回热数据', !!state.posts.w1);
  ok('搬回来后状态是 pending（要重新判定）', state.posts.w1?.status === 'pending');
  ok('记录了唤醒原因', !!state.posts.w1?.wakeReason);
  ok('冷库里标记为已唤醒', !isCold(db, 'w1'));
}

// ---------- 7. 通知驱动的唤醒（2026-11-04） ----------
{
  const db = openTestDb();
  putCold(db, { id: 'n1', title: '冷帖A', author: '路人', authorId: '888' }, {
    category: 'question',
    text: '困难6怎么过',
    commentCount: 1,
    lastInteractionAt: NOW - 100 * DAY,
    now: NOW,
  });
  putCold(db, { id: 'n2', title: '冷帖B', author: '路人2', authorId: '889' }, {
    category: 'question',
    text: '别的帖',
    commentCount: 1,
    lastInteractionAt: NOW - 100 * DAY,
    now: NOW,
  });
  const notes = [
    { momentId: 'n1', title: '回复了你的评论', content: '@小鲸鱼 看看', senderName: '路人', quoted: '' },
    { momentId: 'n2', title: '赞了你的帖子', content: '好厉害', senderName: '路人2', quoted: '' },
    { momentId: 'n3', title: '回复了你的评论', content: '@小鲸鱼', senderName: '路人3', quoted: '' },
  ];
  const state = { posts: {} };
  const isAboutMe = (n) => !/赞/.test(n.title);
  const r = wakeByNotifications(db, state, notes, { config: { myUserId: '999' }, isAboutMe });
  ok('通知唤醒 1 条（只有回复/@我的算）', r.woken === 1, JSON.stringify(r.items));
  ok('被唤醒的冷帖搬回热数据', !!state.posts.n1);
  ok('点赞的不唤醒', !state.posts.n2);
  ok('通知里没有的帖子不受影响', !state.posts.n3);
  ok('唤醒后冷库标记已唤醒', !isCold(db, 'n1'));
}

// ---------- 8. 通知解析 ----------
{
  const raw = {
    id: 92716301981,
    action: 'comment',
    sender: { type: 'user', user: { id: 791105472, name: '萝卜' } },
    data: {
      title: '回复了你的评论',
      content: '@枫******Zo: 给你看看我的',
      uri: 'https://www.taptap.cn/moment/866300950728409356#comment-id=404364961',
    },
    extend: { contents: { type: 'post', content: '就冲萝卜大佬这句，我先试为敬 「版主助手-小鲸鱼」[表情]' } },
    created_time: 1793766294,
  };
  const p = parseNotification(raw);
  ok('解析出帖子 id', p.momentId === '866300950728409356', p.momentId);
  ok('解析出评论 id', p.commentId === '404364961', p.commentId);
  ok('解析出发信人', p.senderName === '萝卜');
  ok('解析出被回复的内容', p.quoted.includes('版主助手-小鲸鱼'));
  ok('回复我的 → 是关于我', isAboutMe(p, { ourNames: ['枫******Zo'] }) === true);
  const like = parseNotification({ ...raw, data: { ...raw.data, title: '赞了你的帖子', content: '好厉害' } });
  ok('点赞 → 不是「要我回话」', isAboutMe(like, {}) === false);
}

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
