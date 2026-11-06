#!/usr/bin/env node
// 夸奖对象挑选 回归测试（2026-11-04 精简）
//
// 原来这个文件还测「夸奖文案模板」（18 套模板、口吻护栏、够短、够散）。
// 用户 2026-11-04 明确要求模板废弃 → 文案改由 LLM 生成（lib/compose-reply.mjs kind='praise'），
// 那些断言删掉；这里只保留**还在用**的「挑对象」逻辑。
//
// 改 scripts/lib/praise.mjs 或 summarize.mjs 的 isUsefulAnswer 前后各跑一次：
//   node scripts/test-praise.mjs

import { pickPraiseTarget } from './lib/praise.mjs';
import { openPraiseDb, savePraise, similarPraise } from './lib/praise-store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

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
const fails = [];
const check = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

console.log('\n== pickPraiseTarget ==');
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
  mk('14', '戊', '905', '天宫码 JFAABCDEFG'),
];
check('全是无效回答 → 不夸', pickPraiseTarget(junk, { myUserId: '999' }) === null);

console.log('\n== 楼中楼回答 → 挂父评论 ==');
const nested = [
  mk('20', '楼主', '1', '求助：这关怎么过', {
    child: [mk('21', '热心人C', '444', '困难6用机枪加冰车就行，我40级通关了')],
  }),
];
const t3 = pickPraiseTarget(nested, { myUserId: '999' });
check('楼中楼回答挂到父评论 id=20', t3 && t3.targetCommentId === '20', JSON.stringify(t3?.targetCommentId));
check('isNested 标记正确', t3 && t3.isNested === true);

console.log('\n== similarPraise（检查程序，主流程不调用） ==');
{
  const tmp = join(tmpdir(), `praise-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  let db = null;
  try {
    db = openPraiseDb({ paths: { praiseDbFile: tmp } });
    savePraise(db, {
      postId: 'p1',
      commentId: 'c1',
      author: '甲',
      commentText: '困难6用机枪加冰车就行，先控住再输出',
      praiseText: '这个思路稳',
    });
    savePraise(db, {
      postId: 'p2',
      commentId: 'c2',
      author: '乙',
      commentText: '钻石主要靠签到和每日任务',
      praiseText: '说得实在',
    });

    const sim = similarPraise(db, { commentText: '困难6用机枪加冰车', topN: 3, minScore: 0.1 });
    check('能按相似度捞出历史夸奖', sim.length > 0, JSON.stringify(sim));
    check('最相似的那条排第一', sim[0] && sim[0].text === '这个思路稳', JSON.stringify(sim[0]));
    check('返回带作者和分数', sim[0] && sim[0].author === '甲' && typeof sim[0].score === 'number', JSON.stringify(sim[0]));

    const none = similarPraise(db, { commentText: '植物阶数怎么升', topN: 3, minScore: 0.95 });
    check('阈值调高就不返回', none.length === 0, JSON.stringify(none));
    check('db 为空时安全返回空数组', similarPraise(null, { commentText: 'x' }).length === 0);
  } finally {
    try {
      db?.close?.();
    } catch {}
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
