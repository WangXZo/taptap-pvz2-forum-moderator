#!/usr/bin/env node
// 答疑库体检（剔除携带自己标签的条目）回归测试
//
// 改 scripts/lib/qa-health.mjs 或 collect.mjs 的体检钩子前后各跑一次：
//   node scripts/test-qa-health.mjs
//
// 背景：沉淀逻辑曾把自己盖的夸奖楼当成「最佳答案」收进答疑库，
//      导致库里的「答案」变成「依******梦 说得又准又细…「版主助手-小鲸鱼」」。
//      生成端已挡，这里锁的是**存量清理**与**每天一次的频率判断**。

import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tagsFromConfig,
  scanTagged,
  renderLibrary,
  purgeTagged,
  shouldHealthCheck,
  FALLBACK_TAGS,
} from './lib/qa-health.mjs';

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

const SIG = '「版主助手-小鲸鱼」';
const HEADER = '# 植物大战僵尸2 · 答疑库\n\n> 说明文字\n';

const HEALTHY = `
## 问：钻石怎么快速获得
- 关键词：钻石, 刷钻
- 版本：通用
---
钻石主力就靠签到和每日任务，先领满。

## 问：未来礼盒什么时候返场
- 关键词：未来礼盒, 返场
- 来源：https://www.taptap.cn/moment/863747312214608939
- 总结时间：2026-10-28 09:55:36
- 摘自：依******梦（成就党）
---
下个版本活动更新了应该就有了。
`;

const DIRTY = `
## 问：回忆之旅乱码
- 关键词：回忆之旅, 乱码
- 来源：https://www.taptap.cn/moment/864169893405134526
- 总结时间：2026-10-28 09:15:43
- 摘自：枫之****Zo（版主）
---
依******梦 说得又准又细，省了大家很多摸索 ${SIG}

## 问：私人拖尾
- 关键词：私人拖尾
- 来源：https://www.taptap.cn/moment/864173783009724265
- 总结时间：2026-10-28 09:15:51
- 摘自：1******3（答疑智多星）
---
活动已经到期了，等下次吧。
补充：谢谢 1******3 耐心解答，正是新手需要的那种答案 ${SIG}
`;

console.log('== tagsFromConfig：标签从配置推出来 ==');
const tags = tagsFromConfig({ reply: { signature: SIG } });
check('含完整签名', tags.includes(SIG), JSON.stringify(tags));
check('含去书名号的内文', tags.includes('版主助手-小鲸鱼'), JSON.stringify(tags));
check('含兜底关键词', FALLBACK_TAGS.every((t) => tags.includes(t)), JSON.stringify(tags));
check('无重复', new Set(tags).size === tags.length, JSON.stringify(tags));
const noSig = tagsFromConfig({ reply: {} });
check('签名没配也还有兜底', FALLBACK_TAGS.every((t) => noSig.includes(t)), JSON.stringify(noSig));

console.log('\n== scanTagged：只认正文里的标签 ==');
const clean = scanTagged(HEADER + HEALTHY, tags);
check('干净库 → 0 命中', clean.hits.length === 0, JSON.stringify(clean.hits));
check('干净库 → 2 条保留', clean.keep.filter((b) => /^##\s/m.test(b)).length === 2);

const dirty = scanTagged(HEADER + HEALTHY + DIRTY, tags);
check('脏库 → 命中 2 条', dirty.hits.length === 2, String(dirty.hits.length));
check('命中记下了标签', dirty.hits.every((h) => h.tag), JSON.stringify(dirty.hits.map((h) => h.tag)));
check('命中记下了问法', dirty.hits.some((h) => /回忆之旅乱码/.test(h.question)), JSON.stringify(dirty.hits.map((h) => h.question)));
check('脏库 → 只保留干净的那 2 条', dirty.keep.filter((b) => /^##\s/m.test(b)).length === 2);

// 关键：标签只出现在元数据「摘自：」里，正文干净 → 不能误伤
const metaOnly = `
## 问：某条正常问答
- 关键词：正常
- 摘自：枫之****Zo（版主）
---
这是一条正常答案，正文里没有签名。
`;
const m = scanTagged(HEADER + metaOnly, tags);
check('标签只在元数据里 → 不算命中（避免误伤）', m.hits.length === 0, JSON.stringify(m.hits.map((h) => h.question)));

console.log('\n== renderLibrary：拼回去不丢东西 ==');
const rendered = renderLibrary(dirty.header, dirty.keep);
check('保留 header', rendered.startsWith('# 植物大战僵尸2 · 答疑库'));
check('不含被剔除的条目', !rendered.includes('回忆之旅乱码') && !rendered.includes('私人拖尾'));
check('保留正常条目', rendered.includes('钻石怎么快速获得') && rendered.includes('未来礼盒什么时候返场'));

console.log('\n== purgeTagged：默认只体检，不写文件 ==');
const dir = await mkdtemp(join(tmpdir(), 'qahealth-'));
const qaFile = join(dir, '答疑库.md');
const archiveDir = join(dir, '归档');
const original = HEADER + HEALTHY + DIRTY;
await writeFile(qaFile, original, 'utf8');

const dry = await purgeTagged({ qaFile, archiveDir, tags, apply: false });
check('体检报出 2 条', dry.hits.length === 2, String(dry.hits.length));
check('体检不写主库', (await readFile(qaFile, 'utf8')) === original);
check('体检不生成归档', (await readdir(dir)).filter((f) => f !== '答疑库.md').length === 0, JSON.stringify(await readdir(dir)));

console.log('\n== purgeTagged --apply：移动不删除 + 可回退 ==');
const res = await purgeTagged({ qaFile, archiveDir, tags, apply: true, now: new Date('2026-10-28T13:00:00') });
const after = await readFile(qaFile, 'utf8');
check('剔除 2 条', res.hits.length === 2);
check('主库 4 → 2', res.before === 4 && res.after === 2, `${res.before} → ${res.after}`);
check('主库已无签名', !after.includes('小鲸鱼'), after.slice(0, 120));
check('主库仍保留正常条目', after.includes('钻石怎么快速获得') && after.includes('未来礼盒什么时候返场'));
check('归档文件已生成', !!res.archivedFile && (await readdir(archiveDir)).length === 1, String(res.archivedFile));
const arch = await readFile(res.archivedFile, 'utf8');
check('归档里保留了被剔除的原文', arch.includes('回忆之旅乱码') && arch.includes('私人拖尾'));
check('归档里写明了命中标签', arch.includes('命中标签'));
check('备份文件已生成', !!res.backupFile && (await readdir(dir)).some((f) => f.includes('before-purge')), String(res.backupFile));

const again = await purgeTagged({ qaFile, archiveDir, tags, apply: true });
check('再体检 → 干净', again.hits.length === 0 && again.before === 2, JSON.stringify(again.hits));

console.log('\n== shouldHealthCheck：每天一次（用户明确不要太频繁）==');
const T = (s) => new Date(s);
check('从没跑过 → 该跑', shouldHealthCheck({}, T('2026-10-28T10:00:00')) === true);
check('空 usage 对象也能跑', shouldHealthCheck({ items: {} }, T('2026-10-28T10:00:00')) === true);
check('1 小时前跑过 → 不跑', shouldHealthCheck({ lastHealthAt: '2026-10-28T09:00:00' }, T('2026-10-28T10:00:00')) === false);
check('23 小时前跑过 → 不跑', shouldHealthCheck({ lastHealthAt: '2026-10-27T11:00:00' }, T('2026-10-28T10:00:00')) === false);
check('刚好 24 小时 → 跑', shouldHealthCheck({ lastHealthAt: '2026-10-27T10:00:00' }, T('2026-10-28T10:00:00')) === true);
check('25 小时前跑过 → 跑', shouldHealthCheck({ lastHealthAt: '2026-10-27T09:00:00' }, T('2026-10-28T10:00:00')) === true);
check(
  '可配置周期（6 小时）',
  shouldHealthCheck({ lastHealthAt: '2026-10-28T03:30:00' }, T('2026-10-28T10:00:00'), 6) === true
);
check('时间戳坏了 → 当作该跑', shouldHealthCheck({ lastHealthAt: 'not-a-date' }, T('2026-10-28T10:00:00')) === true);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
