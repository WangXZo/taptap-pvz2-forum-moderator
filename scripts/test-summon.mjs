#!/usr/bin/env node
// 签名识别 + 回复护栏 回归测试（2026-11-04 精简）
//
// 这一文件原来测的是「9 个语义桶 + 160 条模板文案」。
// 用户 2026-11-04 明确要求模板废弃（回复改由 LLM 按三层上下文生成）→ 那些断言全部删掉，
// 只保留**还在用**的两块：
//   ① 签名识别（lib/signature.mjs）：我们回过没 / 玩家在喊我们
//   ② 回复护栏（lib/summon.mjs 的 assertKind）：不贬低、不替官方承诺
//
// 改 lib/signature.mjs 或 lib/summon.mjs 前后各跑一次：
//   node scripts/test-summon.mjs

import { isOurReplyText, isSummonText, findTag, squash, teamUserIdsOf } from './lib/signature.mjs';
import { assertKind } from './lib/summon.mjs';

let pass = 0;
const fails = [];
const check = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

const SIG = '「版主助手-小鲸鱼」';
const config = {
  reply: { signature: SIG },
  summon: { aliases: ['大肥鱼', '肥鱼', '吃白米饭的'], matchRoles: true },
  myUserId: '6******4',
};

// ---------- A. 签名识别：我们回过 vs 玩家喊我们 ----------
console.log('\n[A] 签名识别');
check('正文含签名 → 是我们发的', isOurReplyText('这句话没问题 ' + SIG, config) === true);
check('结尾含签名 → 是我们发的', isOurReplyText('回答内容 ' + SIG + ' [表情_点赞]', config) === true);
check('没签名 → 不是我们发的', isOurReplyText('玩家随便说的一句话', config) === false);

// ---------- A2. 现在的真实形态：签名与正文**同一行**，且在表情之前（2026-11-10） ----------
// 签名改成由脚本统一追加（不再独立成段），所以必须确认「识别自己」没被改坏。
{
  const real = [
    ['安慰帖', '差一点没完成的那种最憋屈，前面都熬过来了。别太自责，这波认了 ' + SIG + '[表情_加油]'],
    ['答疑帖', '困难6的关键是先控住。用冰车冻住前排，再上机枪输出 ' + SIG + '[表情_点赞]'],
    ['分享互动', '恭喜恭喜，这波肝得值了 ' + SIG + '[表情_星星眼]'],
    ['表情放中间', '先把[表情_加油]材料攒够 ' + SIG],
  ];
  for (const [why, t] of real) {
    check(`同形态识别自己（${why}）`, isOurReplyText(t, config) === true, t);
    check(`同形态不算喊话（${why}）`, isSummonText(t, config).summon === false, t);
  }
  // 加好友固定话术仍是「签名独立成段」——两种形态都得认
  check('签名独立成段 → 也算我们自己', isOurReplyText('你好呀，好友码集中贴已置顶\n\n' + SIG, config) === true);

  // 反向：玩家拿签名喊我们，不能被当成「我们回过」
  check('玩家道谢不算我们发的', isOurReplyText('谢谢 ' + SIG + '[表情_比心]', config) === false);
  check('玩家喊话不算我们发的', isOurReplyText('小鲸鱼在吗[表情_吃瓜]', config) === false);
  check('光秃秃一个称呼不算', isOurReplyText(SIG, config) === false);
}

// 玩家喊我们的 5 个别名（用户 2026-11-02 点名的）
for (const alias of ['大肥鱼', '版主助手-小鲸鱼', '版主助手', '小鲸鱼', '吃白米饭的', '肥鱼']) {
  const hit = isSummonText(`${alias}！！！出来道歉`, config);
  check(`喊「${alias}」→ 认得`, hit.summon, JSON.stringify(hit));
}
check('喊「小鲸鱼在吗」→ 认得', isSummonText('小鲸鱼在吗', config).summon);
// 用户 2026-11-10：「如果有人喊大肥鱼/小鲸鱼/肥鱼，大概率就是喊你」→ 单独的「肥鱼」也要认
for (const t of ['肥鱼', '肥鱼在吗', '肥鱼这次活动咋领', '肥鱼帮我看看']) {
  check(`喊「${t}」→ 认得`, isSummonText(t, config).summon, t);
}
check('「版主 + 呼叫语气」→ 认得', isSummonText('版主在吗，帮忙看下', config).summon);
check('普通聊天 → 不认', !isSummonText('今天天气不错', config).summon);
check('我们自己的回话 → 不算被喊', !isSummonText('我在的，你说 ' + SIG, config).summon);

// findTag / squash / teamUserIds
// （findTag 返回的是**归一化后**的标签：括号、空格、连字符都被去掉了）
check('findTag 找到长标签优先', findTag('版主助手-小鲸鱼在吗', config)?.tag === '版主助手小鲸鱼');
check('squash 去掉括号和空格', squash('「版主助手-小鲸鱼」') === '版主助手小鲸鱼');
check('teamUserIds 忽略脱敏占位', !teamUserIdsOf({ myUserId: '6***4', teamUserIds: [] }).includes('6***4'));

// ---------- B. 回复护栏 ----------
console.log('\n[B] 回复护栏 assertKind');
check('正常话 → 通过', assertKind('困难6先控住再输出，我40级过的').ok);
check('贬低玩家 → 拦下', !assertKind('这问题真蠢').ok);
check('辱骂 → 拦下', !assertKind('菜鸡').ok);
check('替官方承诺 → 拦下', !assertKind('保证下版本就修好了').ok);
check('承诺补偿 → 拦下', !assertKind('官方会给补偿的').ok);
check('空文案 → 拦下', !assertKind('').ok);

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
