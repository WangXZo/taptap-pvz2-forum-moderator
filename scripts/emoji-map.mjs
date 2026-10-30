#!/usr/bin/env node
// 采集「表情名 → 表情 id」映射（接口回复里要发 tap_emoji 节点就必须有 id）
//
// 为什么要这一步：
//   点 UI 发消息时，编辑器自己把表情变成 <span data-type="tapEmoji"> 节点后提交；
//   走接口直连没有编辑器，只能自己拼同样的节点 —— 节点里必须有 info.id，
//   而这个 id 只有把表情面板打开、读面板里的 <img data-tap-editor-emoji-id> 才能拿到。
//   所以采一次、存成 data/emoji-map.json，接口回复时直接查表。
//
// 用法：
//   node scripts/emoji-map.mjs                # 采集并保存（覆盖旧表）
//   node scripts/emoji-map.mjs --show         # 只打印现有表
//   node scripts/emoji-map.mjs --session tapmod

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner } from './lib/replier.mjs';
import { makeTapApi } from './lib/taptap-api.mjs';
import { ensurePanelOpen } from './lib/emoji.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'data/emoji-map.json');
const config = JSON.parse(readFileSync(resolve(ROOT, 'scripts/config.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const session = flag('session', config.modTasks?.session || config.reply.session || 'tap');

if (argv.includes('--show')) {
  if (!existsSync(OUT)) {
    console.log('还没有表情表（先跑一次不带 --show 的采集）');
    process.exit(0);
  }
  const m = JSON.parse(readFileSync(OUT, 'utf8'));
  console.log(`共 ${Object.keys(m).length} 个表情（${OUT}）`);
  for (const [k, v] of Object.entries(m)) console.log(`  ${k} → id=${v.id}  ${String(v.url).slice(0, 60)}`);
  process.exit(0);
}

const runner = makeRunner({ opencliMain: config.reply.opencliMain, session });
if (!runner.available) {
  console.error(runner.reason);
  process.exit(1);
}
const api = makeTapApi({ runner, log: console.log, intervalMs: 1000 });

// 挑一个能打开评论编辑器的帖子：用配置里那个置顶的「好友码集中贴」
const anchor =
  String(config.modTasks?.friendRequest?.reply || '').match(/\/moment\/(\d+)/)?.[1] || '864806259805654695';
const url = `https://www.taptap.cn/moment/${anchor}`;
console.log(`打开锚点帖：${url}`);
const o = runner.oc(['browser', runner.session, 'open', url], { timeout: 90000 });
if (o.code !== 0) {
  console.error('打开失败：', String(o.out || '').slice(0, 200));
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 6000));

const ok = await ensurePanelOpen(runner.oc, runner.session, {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
if (!ok) {
  console.error('表情面板打不开（页面可能没加载出编辑器）');
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 1200));

const map = api.emojiMap();
const n = Object.keys(map).length;
if (!n) {
  console.error('面板里没读到表情图片');
  process.exit(3);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(map, null, 1), 'utf8');
console.log(`已采集 ${n} 个表情 → ${OUT}`);
for (const [k, v] of Object.entries(map).slice(0, 20)) console.log(`  ${k} → id=${v.id}`);
