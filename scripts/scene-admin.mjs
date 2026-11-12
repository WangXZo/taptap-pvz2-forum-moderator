#!/usr/bin/env node
// 场景负反馈 · 人工管理（用户 2026-11-12）
//
// 用法：
//   node scripts/scene-admin.mjs list              # 看各场景分数 / 档位 / 冷却 / 被踢出的帖数
//   node scripts/scene-admin.mjs reset praise_code # 解除某一个场景（清分数 + 冷却 + 踢出凭据）
//   node scripts/scene-admin.mjs reset-all         # 解除全部场景
//
// 场景：praise_code（贴码捧场）/ share_reply（分享凑热闹）/ comfort（情绪陪聊）
//
// ⚠️ 解除会同时清三处，缺一不可：
//   ① state.sceneFeedback[scene]   分数（collect 写）
//   ② state.sceneCooldown[scene]   冷却（collect 写）
//   ③ data/watch-scene-skip.json   被踢出的帖子凭据（watch 写）—— 不清的话那些帖仍不入队
// watch 每轮会重读 ③，所以解除**即时生效，不用重启守护**。
//
// ⚠️ 建议在守护两轮之间跑（state.json 归 collect 管，避免正好撞上它写盘）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadConfig } from './lib/paths.mjs';
import { loadState, saveState } from './lib/state.mjs';
import {
  CHATTER_SCENES,
  SCENE_LABEL,
  effectiveScore,
  sceneStatus,
  resolveBands,
} from './lib/scene-feedback.mjs';

const config = await loadConfig();
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const target = argv[1];

const stateFile = config.paths.stateFile;
const skipFile = resolve(config.paths.dataDir || '.', 'watch-scene-skip.json');
const bands = resolveBands(config.sceneFeedback);
const halfLifeMs = Number(config.sceneFeedback?.halfLifeHours ?? 24) * 3600 * 1000;

async function loadSkips() {
  try {
    const s = JSON.parse(await readFile(skipFile, 'utf8')) || {};
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}
async function saveSkips(s) {
  await mkdir(dirname(skipFile), { recursive: true }).catch(() => {});
  await writeFile(skipFile, JSON.stringify(s, null, 1), 'utf8');
}

function showRow(scene, state, skips) {
  const score = effectiveScore(state, scene, Date.now(), halfLifeMs);
  const st = sceneStatus(state, scene, { bands, halfLifeMs });
  const cd = state?.sceneCooldown?.[scene];
  const cdLeft = cd?.until ? Math.max(0, Math.round((cd.until - Date.now()) / 60000)) : 0;
  const skipCount = Object.values(skips).filter((s) => s?.scene === scene).length;
  const lvl = { normal: '观察', downgraded: '降权', cooldown: '冷却' }[st.level] || st.level;
  console.log(
    `  ${scene.padEnd(13)} ${(SCENE_LABEL[scene] || '').padEnd(8)} ` +
      `分数=${score.toFixed(2).padStart(6)}  档位=${lvl}  ` +
      `冷却剩=${cdLeft}min  被踢帖=${skipCount}`
  );
}

if (cmd === 'list') {
  const state = await loadState(stateFile);
  const skips = await loadSkips();
  console.log('场景负反馈现状（区间：normal (−∞,1.5) / downgraded [1.5,2.5) / cooldown [2.5,∞)）：');
  for (const scene of CHATTER_SCENES) showRow(scene, state, skips);
  process.exit(0);
}

if (cmd === 'reset' || cmd === 'reset-all') {
  const scenes = cmd === 'reset-all' ? CHATTER_SCENES : [target];
  if (cmd === 'reset' && !CHATTER_SCENES.includes(target)) {
    console.error(`未知场景「${target}」。可选：${CHATTER_SCENES.join(' / ')}`);
    process.exit(1);
  }
  const state = await loadState(stateFile);
  const skips = await loadSkips();
  for (const scene of scenes) {
    if (state.sceneFeedback) delete state.sceneFeedback[scene];
    if (state.sceneCooldown) delete state.sceneCooldown[scene];
    for (const [id, s] of Object.entries(skips)) {
      if (s?.scene === scene) delete skips[id];
    }
    console.log(`  ✓ 已解除「${SCENE_LABEL[scene] || scene}」：分数清零 + 冷却取消 + 踢出凭据移除`);
  }
  await saveState(stateFile, state);
  await saveSkips(skips);
  console.log('解除完成。watch 下一轮会重读凭据，即时生效（不用重启）。');
  process.exit(0);
}

console.error('用法：scene-admin.mjs list | reset <scene> | reset-all');
process.exit(1);
