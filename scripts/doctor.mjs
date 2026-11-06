#!/usr/bin/env node
// 一键自检：装完先跑这个，确认环境/配置/数据都正常
//
// 用法：node scripts/doctor.mjs
//
// 设计原则：**只读**。体检不改任何文件、不发任何请求到论坛、不动浏览器。
// 只做两件可能碰外部的事：① 读本地文件；② 问 opencli「扩展连上没有」（只读探针）。
//
// 退出码：0 = 全绿；1 = 有问题（每条都给出怎么修）

import { readFile, access, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, SKILL_ROOT } from './lib/paths.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { scanTagged, tagsFromConfig } from './lib/qa-health.mjs';
import { resolveOpencliMain, makeRunner, doctorOk } from './lib/replier.mjs';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let bad = 0;
let warn = 0;

function ok(msg, extra = '') {
  console.log(`  ${C.g}✓${C.x} ${msg}${extra ? C.d + '  ' + extra + C.x : ''}`);
}
function bad1(msg, fix = '') {
  bad++;
  console.log(`  ${C.r}✗${C.x} ${msg}`);
  if (fix) console.log(`    ${C.y}→ ${fix}${C.x}`);
}
function warn1(msg, fix = '') {
  warn++;
  console.log(`  ${C.y}!${C.x} ${msg}`);
  if (fix) console.log(`    ${C.y}→ ${fix}${C.x}`);
}
function head(t) {
  console.log(`\n${C.b}${t}${C.x}`);
}

console.log(`${C.b}TapTap 论坛答疑助手 · 自检${C.x}`);
console.log(`${C.d}${SKILL_ROOT}${C.x}`);

// ---------- 1. 运行环境 ----------
head('1. 运行环境');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) ok(`Node ${process.versions.node}`);
else bad1(`Node ${process.versions.node} 太老`, '需要 Node 18 及以上');

// ---------- 2. 目录结构 ----------
head('2. 目录结构');
const need = [
  ['scripts/config.json', '配置文件'],
  ['scripts/lib', '核心模块'],
  ['qa/答疑库.md', '答疑库'],
  ['references', '参考资料'],
];
for (const [rel, desc] of need) {
  const p = join(SKILL_ROOT, rel);
  try {
    await access(p);
    ok(`${desc}  ${C.d}${rel}${C.x}`);
  } catch {
    bad1(`缺 ${desc}  ${rel}`, '仓库没拉全？重新 clone 或拷贝整个目录');
  }
}

// ---------- 3. 配置 ----------
head('3. 配置');
let config = null;
try {
  config = await loadConfig();
  ok('config.json 解析成功');
} catch (e) {
  bad1(`config.json 读不了：${e.message}`, '检查 scripts/config.json 是不是合法 JSON');
}

if (config) {
  const needCfg = [
    ['appId', '游戏/应用 ID'],
    ['groupId', '论坛版块 ID'],
    ['myUserId', '自己的 user_id'],
  ];
  for (const [k, desc] of needCfg) {
    if (config[k] !== undefined && config[k] !== null && config[k] !== '') ok(`${desc} = ${config[k]}`);
    else bad1(`缺 ${desc}（config.json 的 ${k}）`, k === 'myUserId' ? 'node scripts/whoami.mjs 拿，然后填进 config.json' : '从论坛链接里找 group_id');
  }
  // 仓库里存的是脱敏值（形如 63****64）—— 直接拿来跑会让「我是否已回复」恒判为否，导致重复回复
  if (typeof config.myUserId === 'string' && config.myUserId.includes('*')) {
    bad1(
      'myUserId 是脱敏值（含 *），不能直接跑',
      '跑 node scripts/whoami.mjs 拿你自己的真实 user_id，替换掉 config.json 里的这个值'
    );
  }
  if (config.reply?.signature) ok(`签名 = ${config.reply.signature}`);
  else warn1('没配签名', 'reply.signature 建议填成 「版主助手-你的名字」');
  if (config.reply?.dryRun === false) warn1('当前是「真发」模式', '想先看效果就把它改成 true');
  if (config.reply?.refuseOnUnknown === true) warn1('库里没答案时会自动婉拒', '不想自动说话就改成 false');

  // 多人协作：签名识别（队友的 id 填了就能更准）
  const team = (config.teamUserIds || []).filter((x) => String(x || '').trim());
  if (team.length) ok(`团队成员 ${team.length} 个（签名之外的第二道判据）`);
  else
    warn1(
      '没填 teamUserIds',
      '不影响运行（靠签名识别），但填上队友的 user_id 更准 —— config.json 的 teamUserIds'
    );

  // 玩家喊我们 → 过去互动
  if (config.summon?.enabled !== false) {
    const aliases = (config.summon?.aliases || []).map((x) => String(x || '').trim()).filter(Boolean);
    const masked = aliases.filter((a) => a.includes('*'));
    if (masked.length)
      warn1(
        `summon.aliases 里有脱敏占位：${masked.join('、')}`,
        '仓库里的脱敏值永远匹配不到 —— 换成你自己的昵称（别带括号，带不带「」都能认）'
      );
    if (aliases.length) ok(`喊话别名 ${aliases.length} 个：${aliases.join('、')}`);
    else warn1('没配 summon.aliases', '只认签名的话，玩家用你的其它昵称喊你就会漏掉');
  }
}

// ---------- 4. 浏览器桥接 ----------
head('4. 浏览器桥接（opencli）');
const main = resolveOpencliMain(config?.reply?.opencliMain);
if (!main) {
  bad1('找不到 opencli', 'npm i -g @jackwener/opencli  然后重新跑本脚本');
} else {
  ok(`opencli 入口 ${C.d}${main}${C.x}`);
  const runner = makeRunner({ opencliMain: main, session: config?.reply?.session || 'tap' });
  const d = doctorOk(runner);
  if (d.ok) ok('浏览器扩展已连接', '可以发回复了');
  else {
    bad1('浏览器扩展没连上', '① 确认 Chrome 已打开并登录 TapTap；② opencli daemon restart；③ 检查扩展是否启用');
    console.log(`    ${C.d}${(d.text || '').split('\n').slice(0, 4).join('\n    ')}${C.x}`);
  }
}

// ---------- 5. 答疑库 ----------
head('5. 答疑库');
try {
  const qa = await loadQaLibrary(config.paths.qaFile);
  const auto = qa.filter((e) => e.auto).length;
  ok(`加载成功：${qa.length} 条（社区沉淀 ${auto} 条 / 人工 ${qa.length - auto} 条）`);
  if (qa.length < 10) warn1('条目偏少', '命中率会低 —— 见 qa/待补充问题.md，认领几条补上');

  // 带自己标签的脏条目（曾经的 bug：把自己的夸奖沉淀成答案）
  const raw = await readFile(config.paths.qaFile, 'utf8');
  const hits = scanTagged(raw, tagsFromConfig(config)).hits;
  if (hits.length) {
    warn1(`有 ${hits.length} 条携带自己标签的条目`, 'node scripts/qa-admin.mjs purge-tag --apply  清掉');
    hits.slice(0, 3).forEach((h) => console.log(`      《${h.question.slice(0, 24)}》 命中「${h.tag}」`));
  } else {
    ok('没有携带自己标签的脏条目');
  }
} catch (e) {
  bad1(`答疑库读不了：${e.message}`, '检查 qa/答疑库.md 是否存在、格式是否正确');
}

// ---------- 6. 运行时目录 ----------
head('6. 运行时目录');
for (const [k, p] of Object.entries(config?.paths || {})) {
  const isFile = /\.(json|md)$/i.test(p);
  try {
    const s = await stat(p);
    ok(`${k.padEnd(10)} ${C.d}${p.replace(SKILL_ROOT, '{{SKILL}}')}${C.x}`, s.isDirectory() ? '(目录)' : '(文件)');
  } catch {
    if (isFile) {
      // 文件还没生成是正常的：第一次跑一轮就会建出来
      const parent = dirname(p);
      try {
        await access(parent);
        warn1(`${k} 还没生成`, '第一次跑一轮就会自动创建（这是正常的）');
      } catch {
        bad1(`${k} 的目录不存在：${parent.replace(SKILL_ROOT, '{{SKILL}}')}`, 'node scripts/install.mjs');
      }
    } else {
      bad1(`${k} 目录不存在：${p.replace(SKILL_ROOT, '{{SKILL}}')}`, 'node scripts/install.mjs');
    }
  }
}
try {
  const s = await stat(config.paths.stateFile);
  ok('状态库可读', `${((await readFile(config.paths.stateFile, 'utf8')).length / 1024).toFixed(1)} KB`);
  void s;
} catch {
  /* 上面已提示 */
}

// ---------- 7. 仓库同步状态 ----------
head('7. 答疑库同步（仓库 ↔ 运行中）');
try {
  const { execFileSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  let repoQa = join(SKILL_ROOT, 'qa', '答疑库.md');
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: SKILL_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) repoQa = join(top, 'qa', '答疑库.md');
  } catch {
    /* 不在 git 仓库里 */
  }
  const a = await readFile(repoQa, 'utf8');
  const b = await readFile(config.paths.qaFile, 'utf8');
  if (resolve(repoQa) === resolve(config.paths.qaFile)) {
    console.log(`  ${C.d}当前就是仓库本体（没有另一份运行中副本可对比）${C.x}`);
  } else if (a === b) ok('仓库副本与运行中一致');
  else {
    warn1(
      '仓库副本与运行中不一致',
      'node scripts/qa-sync.mjs --status 看差异，再 --to-repo / --to-runtime（--apply 才写）'
    );
  }
} catch {
  console.log(`  ${C.d}(无法比对，跳过)${C.x}`);
}

// ---------- 8. LLM 渠道（回复生成用） ----------
head('8. LLM 渠道（回复生成）');
try {
  const { describeChannels } = await import('./lib/llm.mjs');
  const chs = await describeChannels(config);
  if (!chs.length) {
    bad1(
      '没有可用的 LLM 渠道 —— 回复生成不出来',
      '要么在 scripts/config.json 的 llm 段填 apiKey/baseURL/model，要么确认 ~/.dsh 里有可用凭据'
    );
  } else {
    for (const c of chs) {
      const tag = c.source === 'config' ? '自带 Key' : 'DSH 复用';
      ok(`${tag}  ${c.provider}/${c.model}`, C.d + c.api + '  ' + c.baseURL + C.x);
    }
    ok(`共 ${chs.length} 条渠道可用`, C.d + '按顺序尝试，失败自动切下一条' + C.x);
  }
} catch (e) {
  bad1('LLM 渠道检查失败：' + e.message);
}

// ---------- 9. 分层唤醒（冷帖重新变热的规则） ----------
head('9. 分层唤醒规则');
try {
  const { shouldWake } = await import('./lib/cold-store.mjs');
  const cfg = { ...config, myUserId: config.myUserId || 'ME' };
  const own = { id: 'x', author_id: cfg.myUserId, comment_count: 2 };
  const other = { id: 'y', author_id: 'OTHER', comment_count: 1 };
  const isSummon = (t) => /大肥鱼|小鲸鱼|版主助手/.test(String(t || ''));
  const isOurs = () => false;

  const w1 = shouldWake({ coldRow: own, comments: [{ text: '新回复' }], config: cfg, isSummon, isOurComment: isOurs });
  ok('我的帖 · 有人回（含楼中楼）→ 唤醒', w1.wake === true, w1.reason);

  const w2 = shouldWake({
    coldRow: other,
    comments: [{ text: '@版主助手-小鲸鱼 看看这个' }],
    config: cfg,
    isSummon,
    isOurComment: isOurs,
  });
  ok('别人的帖 · @我 → 唤醒', w2.wake === true, w2.reason);

  const w3 = shouldWake({
    coldRow: other,
    comments: [{ text: '大肥鱼出来一下' }],
    config: cfg,
    isSummon,
    isOurComment: isOurs,
  });
  ok('别人的帖 · 呼唤我 → 唤醒', w3.wake === true, w3.reason);

  const w4 = shouldWake({
    coldRow: other,
    comments: [{ text: '我也卡这一关' }],
    config: cfg,
    isSummon,
    isOurComment: isOurs,
  });
  ok('别人的帖 · 普通闲聊 → 不唤醒', w4.wake === false, w4.reason);
} catch (e) {
  bad1('分层唤醒规则检查失败：' + e.message);
}

// ---------- 10. 冷热分类（按类别 TTL 冷藏） ----------
head('10. 冷热分类与 TTL');
try {
  const { classifyPost, coldTtlDays, CATEGORIES } = await import('./lib/cold-store.mjs');
  const cfg = { myUserId: config.myUserId || 'ME' };
  const cases = [
    [{ authorId: cfg.myUserId, title: '随便写写' }, 'mine'],
    [{ title: '来加好友呀' }, 'friend'],
    [{ title: '官方公告：版本更新' }, 'official'],
    [{ title: '分享我的通关阵容' }, 'share'],
    [{ title: '困难6怎么过' }, 'question'],
    [{ title: '今天好热' }, 'chat'],
  ];
  for (const [post, want] of cases) {
    const got = classifyPost(post, { config: cfg });
    ok(`分类「${want}」`, got === want, got === want ? '' : `实际 ${got}`);
  }
  const missing = Object.keys(CATEGORIES).filter((k) => !(config.archive?.coldDays || {})[k]);
  if (missing.length) {
    warn1(`冷库 TTL 没配全：${missing.join(',')}`, '配 config.archive.coldDays（不配就用默认天数）');
  } else {
    ok('各类别 TTL 都配了', C.d + JSON.stringify(config.archive.coldDays) + C.x);
  }
  ok('TTL 按类别分别生效', coldTtlDays('friend', config) !== coldTtlDays('official', config));
} catch (e) {
  bad1('冷热分类检查失败：' + e.message);
}

// ---------- 11. 互动续聊（玩家回信 → 接着聊，用户 2026-11-05） ----------
head('11. 互动续聊规则');
try {
  const { pickInteractions, decideInteraction, replyTargetFor } = await import('./lib/interact.mjs');
  const cfg = { ...config };
  const cm = (id, name, text, uid) => ({
    id_str: id,
    author: { name, id: uid || `u_${name}` },
    created_time: 1700000000,
    contents: { json: [{ text }] },
  });
  const flat = [
    { c: cm('C1', '小明', '我按你说的试了，还是打不过'), parentId: 'OUR1' }, // 回复了你
    { c: cm('C2', '小红', '@版主助手-小鲸鱼 在吗'), parentId: null }, // @你
    { c: cm('C3', '小强', '哈哈谢谢'), parentId: 'OUR1' }, // 纯客套
  ];
  const picked = pickInteractions(flat, { config: cfg, ourCommentIds: new Set(['OUR1']), prev: {} });
  ok('「回复了你」→ 命中', picked.some((p) => p.commentId === 'C1'));
  ok('「@你」→ 命中', picked.some((p) => p.commentId === 'C2'));
  ok('纯客套「哈哈谢谢」→ 不回', !picked.some((p) => p.commentId === 'C3'));

  const d1 = decideInteraction({ commentId: 'C1', authorId: 'u1', text: '在吗' }, { counts: {}, config: cfg });
  ok('同帖同玩家没回过 → 直接回', d1.reply === true);
  const d2 = decideInteraction(
    { commentId: 'C1', authorId: 'u1', text: '在吗' },
    { counts: { u1: { n: 3 } }, config: cfg, rng: () => 0.9 }
  );
  ok('同帖同玩家回过 3 次 → 降到 50%', d2.reply === false && d2.probability === 0.5);
  const d3 = decideInteraction(
    { commentId: 'C1', authorId: 'u1', text: '在吗', atUs: true },
    { counts: { u1: { n: 3 } }, config: cfg, rng: () => 0.99 }
  );
  ok('情绪强烈 / 直接点名 → 例外必回', d3.reply === true);

  const t1 = replyTargetFor({ commentId: 'C1', parentId: null, level: 1, author: '小明' });
  const t2 = replyTargetFor({ commentId: 'C2', parentId: 'C1', level: 2, author: '小红' });
  ok('贴内回复 → 回它的楼中楼', t1.parentId === 'C1' && t1.mention === '');
  ok('本身是楼中楼 → 同层并 @ 对方', t2.parentId === 'C1' && t2.mention === '小红');
} catch (e) {
  bad1('互动续聊规则检查失败：' + e.message);
}

// ---------- 结论 ----------
console.log('');
if (bad === 0 && warn === 0) {
  console.log(`${C.g}${C.b}全部通过，可以开工了。${C.x}`);
} else if (bad === 0) {
  console.log(`${C.y}${C.b}有 ${warn} 条提醒，不影响运行。${C.x}`);
} else {
  console.log(`${C.r}${C.b}有 ${bad} 条必须修的问题。${C.x}`);
}
console.log(`${C.d}下一步：node scripts/watch.mjs --dry-run  先看效果（不发送），确认没问题再 node scripts/watch.mjs${C.x}`);
process.exit(bad ? 1 : 0);
