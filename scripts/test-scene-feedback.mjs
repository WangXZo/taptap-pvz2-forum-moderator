#!/usr/bin/env node
// 回归测试：场景级负反馈（跨帖）—— 用户 2026-11-12
//
// 覆盖：
//   ① 场景归属：哪些帖算「捧场类」
//   ② 反感信号识别（含游戏语境防误判）
//   ③ 跨帖计分：帖 A 的反感 → 帖 B 的捧场一起收敛
//   ④ 三档动作：观察 / 降权（只回 1 条 + 25%）/ 冷却（60 分钟）
//   ⑤ 密度信号（跨帖）：30 分钟内同类帖 ≥3 → 泛滥
//   ⑥ 去重：同一条评论只算一次
import {
  sceneOfPost,
  detectDislike,
  detectPraise,
  recordSceneDislike,
  recordScenePraise,
  bumpScene,
  effectiveScore,
  sceneStatus,
  sceneGate,
  coolScene,
  isSceneFlood,
  rollDowngraded,
  isCategoryWide,
  mentionsUs,
  levelOfScore,
  resolveBands,
  DEFAULT_BANDS,
  CHATTER_SCENES,
} from './lib/scene-feedback.mjs';
import { loadConfig } from './lib/paths.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

console.log('=== ① 场景归属 ===');
check('贴码帖 → praise_code', sceneOfPost('安卓天宫码 JFAcUZtLCP', '无偿分享') === 'praise_code');
check('进度分享 → share_reply', sceneOfPost('终于五了！', '肝了好久终于凑齐') === 'share_reply');
check('情绪帖 → comfort', sceneOfPost('我无疑是绝望的', '任务差一点没完成') === 'comfort');
check('普通提问 → null（不属捧场类）', sceneOfPost('困难6怎么过', '求攻略') === null);
check('求码帖 → null（bot 静默，不捧场）', sceneOfPost('求一个天宫码', '好人一生平安') === null);

console.log('\n=== ② 反感信号（游戏语境防误判）===');
check('「又来了」→ 反感', detectDislike('又来了').hit === true);
check('「别贴了」→ 反感', detectDislike('别贴了谢谢').hit === true);
check('「魔了」→ 反感', detectDislike('魔了').hit === true);
check('「这操作魔了」→ 不算（赞叹语境）', detectDislike('这操作魔了，厉害').hit === false);
check('「牛逼」→ 不算', detectDislike('牛逼').hit === false);
check('「我刷了一晚上副本」→ 不算（游戏日常）', detectDislike('我刷了一晚上副本').hit === false);
check('「刷屏了」→ 反感', detectDislike('刷屏了').hit === true);
check('「呵呵」→ 弱信号，不单独触发', detectDislike('呵呵').hit === false);

console.log('\n=== ③ 跨帖计分 ===');
const state = {};
// 半衰期会让刚写入的分数略小于整数（0.99999…），统一用容差比
const near = (a, b) => Math.abs(a - b) < 0.01;
bumpScene(state, 'praise_code', { weight: 1, why: '明确反感', sample: '又来了', cid: 'c1' });
check('场景分 = 1', near(effectiveScore(state, 'praise_code'), 1), `实际 ${effectiveScore(state, 'praise_code')}`);
check('跨帖：别的帖也受影响（分记在场景上，不是帖上）', near(effectiveScore(state, 'praise_code'), 1));
// 同一条评论再记一次 → 不重复计分
bumpScene(state, 'praise_code', { weight: 1, sample: '又来了', cid: 'c1' });
check('同一条评论只算一次', near(effectiveScore(state, 'praise_code'), 1), `实际 ${effectiveScore(state, 'praise_code')}`);
bumpScene(state, 'praise_code', { weight: 1, sample: '魔了', cid: 'c2' });
check('换一条评论 → 累加到 2', near(effectiveScore(state, 'praise_code'), 2), `实际 ${effectiveScore(state, 'praise_code')}`);
check('别的场景不受影响', near(effectiveScore(state, 'share_reply'), 0));
check('非捧场场景不记账', effectiveScore(bumpScene({}, 'qa', { weight: 1 }), 'qa') === 0);

console.log('\n=== ④ 三档动作 ===');
const s2 = {};
bumpScene(s2, 'share_reply', { weight: 1, cid: 'a' });
check('1 分 → 观察（正常）', sceneStatus(s2, 'share_reply').level === 'normal');
bumpScene(s2, 'share_reply', { weight: 1, cid: 'b' });
const st2 = sceneStatus(s2, 'share_reply');
check('2 分 → 降权', st2.level === 'downgraded', st2.why);
const g2 = sceneGate(s2, 'share_reply');
check('降权：不禁止，但提示降权', g2.ok === true && g2.level === 'downgraded');
bumpScene(s2, 'share_reply', { weight: 1, cid: 'c' });
const st3 = sceneStatus(s2, 'share_reply');
check('3 分 → 冷却', st3.level === 'cooldown', st3.why);
const g3 = sceneGate(s2, 'share_reply');
check('冷却：禁止参与这一类', g3.ok === false);
check('冷却只影响捧场类（答疑不受影响）', sceneGate(s2, 'qa').ok === true);
const until = coolScene(s2, 'share_reply', 60, '测试');
check('冷却 60 分钟', until - Date.now() > 58 * 60 * 1000);

console.log('\n=== ⑤ 密度信号（跨帖）===');
const now = Date.now();
const items = [
  { scene: 'praise_code', publishTime: now - 5 * 60 * 1000 },
  { scene: 'praise_code', publishTime: now - 10 * 60 * 1000 },
  { scene: 'praise_code', publishTime: now - 15 * 60 * 1000 },
  { scene: 'share_reply', publishTime: now - 5 * 60 * 1000 },
  { scene: 'praise_code', publishTime: now - 90 * 60 * 1000 }, // 超窗口
];
const flood = isSceneFlood(items, 'praise_code', { nowMs: now, windowMs: 30 * 60 * 1000, maxCount: 3 });
check('30 分钟内 3 条同类 → 泛滥', flood.flood === true && flood.count === 3, JSON.stringify(flood));
const noFlood = isSceneFlood(items, 'share_reply', { nowMs: now, windowMs: 30 * 60 * 1000, maxCount: 3 });
check('别的场景不算泛滥', noFlood.flood === false);

console.log('\n=== ⑥ 降权概率 ===');
check('概率 0 → 一定不回', rollDowngraded({ rng: () => 0.5, prob: 0 }) === false);
check('概率 1 → 一定回', rollDowngraded({ rng: () => 0.5, prob: 1 }) === true);
check('概率 25% + rng=0.1 → 回', rollDowngraded({ rng: () => 0.1, prob: 0.25 }) === true);
check('概率 25% + rng=0.9 → 不回', rollDowngraded({ rng: () => 0.9, prob: 0.25 }) === false);

console.log('\n=== ⑦ 三场景独立 + 同类传染减半（用户 2026-11-12 的例子）===');
const cfg = await loadConfig();
// 玩家在贴码帖下面说：「小鲸鱼你别硬夸了，捧场了」×4
const s3 = {};
for (let i = 0; i < 4; i++) {
  recordSceneDislike(s3, 'praise_code', '小鲸鱼你别硬夸了，捧场了', { config: cfg, cid: `x${i}` });
}
const scP = effectiveScore(s3, 'praise_code');
const scS = effectiveScore(s3, 'share_reply');
const scC = effectiveScore(s3, 'comfort');
check(`贴码捧场 = ${scP.toFixed(3)} 分（指向我们 → 满权重 4）`, near(scP, 4), `实际 ${scP}`);
check(`分享凑热闹 = ${scS.toFixed(3)} 分（同类传染减半 2）`, near(scS, 2), `实际 ${scS}`);
check(`情绪陪聊 = ${scC.toFixed(3)} 分（同类传染减半 2）`, near(scC, 2), `实际 ${scC}`);
check('主场景：冷却（完全停）', sceneStatus(s3, 'praise_code').level === 'cooldown');
check('分享凑热闹：降权（偶尔回一下）', sceneStatus(s3, 'share_reply').level === 'downgraded');
check('情绪陪聊：降权（偶尔回一下）', sceneStatus(s3, 'comfort').level === 'downgraded');

// 只针对一种（不提「捧场」这类类别词）→ 不传染
const s4 = {};
recordSceneDislike(s4, 'praise_code', '小鲸鱼别再贴天宫码了', { config: cfg, cid: 'y1' });
check('只喷天宫码 → 不传染到别的场景', near(effectiveScore(s4, 'share_reply'), 0), `实际 ${effectiveScore(s4, 'share_reply')}`);
check('只喷天宫码 → 主场景照记', near(effectiveScore(s4, 'praise_code'), 1));

// 不是对我们说的（只是嫌这类帖多）→ 半权重
const s5 = {};
recordSceneDislike(s5, 'praise_code', '又来了', { config: cfg, cid: 'z1' });
check('不指向我们 → 半权重 0.5', near(effectiveScore(s5, 'praise_code'), 0.5), `实际 ${effectiveScore(s5, 'praise_code')}`);

// 同一条评论只记一次
const s6 = {};
recordSceneDislike(s6, 'share_reply', '又来了又来了', { config: cfg, cid: 'dup1' });
recordSceneDislike(s6, 'share_reply', '又来了又来了', { config: cfg, cid: 'dup1' });
check('同一条评论不重复计分', near(effectiveScore(s6, 'share_reply'), 0.5), `实际 ${effectiveScore(s6, 'share_reply')}`);

console.log('\n=== ⑧ 信号归属（用户 2026-11-12 定的两条）===');
// ① 提到我们（别名/签名）或第二人称「你」→ 满权重
const s7 = {};
recordSceneDislike(s7, 'praise_code', '小鲸鱼你别硬夸了', { config: cfg, cid: 'a1' });
check('提到别名 → 满权重 1', near(effectiveScore(s7, 'praise_code'), 1), `实际 ${effectiveScore(s7, 'praise_code')}`);
const s8 = {};
recordSceneDislike(s8, 'praise_code', '你别再硬夸了行不行', { config: cfg, cid: 'a2' });
check('第二人称「你」→ 不算对我们说 → 半权重 0.5', near(effectiveScore(s8, 'praise_code'), 0.5), `实际 ${effectiveScore(s8, 'praise_code')}`);
// ② 回复我们/@我们得到的信号 → 一定是说我们（调用方传 toUs）
const s9 = {};
recordSceneDislike(s9, 'share_reply', '魔了', { config: cfg, cid: 'a3', toUs: true });
check('回复我们得到的信号 → 满权重 1', near(effectiveScore(s9, 'share_reply'), 1), `实际 ${effectiveScore(s9, 'share_reply')}`);
const s10 = {};
recordSceneDislike(s10, 'share_reply', '魔了', { config: cfg, cid: 'a4', toUs: false });
check('非回复我们 + 无第二人称 → 半权重 0.5', near(effectiveScore(s10, 'share_reply'), 0.5), `实际 ${effectiveScore(s10, 'share_reply')}`);

console.log('\n=== ⑨ 衰减：24 小时半衰期（昨天的烂场子今天不该继续罚）===');
const NOW = Date.now();
const H = 3600 * 1000;
const decayState = { sceneFeedback: { praise_code: { hits: [] } } };
// 昨天 4 条满权重（昨天 24 小时前）
for (let i = 0; i < 4; i++) {
  decayState.sceneFeedback.praise_code.hits.push({ at: NOW - 24 * H, w: 1, cid: `d${i}`, why: 'test' });
}
const decayed = effectiveScore(decayState, 'praise_code', NOW);
check('24 小时前的 4 分 → 衰减成 2 分', Math.abs(decayed - 2) < 0.01, `实际 ${decayed.toFixed(3)}`);
const stDecay = sceneStatus(decayState, 'praise_code', { nowMs: NOW });
check('昨天的 4 分 → 今天只够「降权」不够「冷却」', stDecay.level === 'downgraded', `${stDecay.level} / ${stDecay.why}`);
const freshState = { sceneFeedback: { praise_code: { hits: [{ at: NOW, w: 1, cid: 'f1' }] } } };
check('刚发生的 1 分 → 满权重 1', Math.abs(effectiveScore(freshState, 'praise_code', NOW) - 1) < 0.001);
const halfLife6 = effectiveScore(freshState, 'praise_code', NOW, 6 * H);
check('半衰期 6 小时时，6 小时前 = 0.5', Math.abs(effectiveScore({ sceneFeedback: { praise_code: { hits: [{ at: NOW - 6 * H, w: 1 }] } } }, 'praise_code', NOW, 6 * H) - 0.5) < 0.001, `实际 ${halfLife6}`);

console.log('\n=== ⑩ 三档区间判断（(−∞,1.5) / [1.5,2.5) / [2.5,∞)）===');
check('1.49 → normal', levelOfScore(1.49) === 'normal');
check('1.5 → downgraded（左闭）', levelOfScore(1.5) === 'downgraded');
check('2.49 → downgraded', levelOfScore(2.49) === 'downgraded');
check('2.5 → cooldown（左闭）', levelOfScore(2.5) === 'cooldown');
check('0 → normal', levelOfScore(0) === 'normal');
check('负分 −1 → normal（正反馈拉回观察）', levelOfScore(-1) === 'normal');
check('resolveBands 空配置 → 默认区间', resolveBands({}) === DEFAULT_BANDS);
check('resolveBands 自定义区间生效', resolveBands({ bands: [{ level: 'cooldown', min: 0, max: null }] })[0].level === 'cooldown');
// 边界分数走完整 sceneStatus（含取整防掉档）
const edgeState = { sceneFeedback: { comfort: { hits: [{ at: NOW, w: 1.5, cid: 'e1' }] } } };
check('恰好 1.5 分 → downgraded（不因浮点掉档）', sceneStatus(edgeState, 'comfort', { nowMs: NOW }).level === 'downgraded');

console.log('\n=== ⑪ 正反馈：玩家夸我们 → −1（用户 2026-11-12）===');
check('detectPraise「谢谢小鲸鱼」→ 命中', detectPraise('谢谢小鲸鱼').hit === true);
check('detectPraise「今天天气不错」→ 不命中', detectPraise('今天天气不错').hit === false);
// 先把场景罚到降权（2 分），再夸一下 → 拉回观察
const posState = {};
bumpScene(posState, 'praise_code', { weight: 1, cid: 'p1' });
bumpScene(posState, 'praise_code', { weight: 1, cid: 'p2' });
check('罚到 2 分 → 降权', sceneStatus(posState, 'praise_code').level === 'downgraded');
const pr = recordScenePraise(posState, 'praise_code', '谢谢小鲸鱼', { config: cfg, cid: 'p3' });
check('夸我们 → 记 −1', pr.hit === true && pr.weight === -1, JSON.stringify(pr));
check('夸完分数 ≈ 1', near(effectiveScore(posState, 'praise_code'), 1), `实际 ${effectiveScore(posState, 'praise_code')}`);
check('夸完 → 拉回观察档', sceneStatus(posState, 'praise_code').level === 'normal');
// 不是夸我们的不算
const posState2 = {};
const pr2 = recordScenePraise(posState2, 'praise_code', '谢谢楼主', { config: cfg, cid: 'q1', toUs: false });
check('「谢谢楼主」（非夸我们）→ 不计', pr2.hit === false);
check('非夸我们 → 分数不变 0', near(effectiveScore(posState2, 'praise_code'), 0));
// 正反馈不传染到别的场景
check('正反馈不传染', near(effectiveScore(posState, 'share_reply'), 0));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);