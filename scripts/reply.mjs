#!/usr/bin/env node
// 补发工具：把历史遗留的「未回复待回复」条目补发出去
// 日常请用 watch.mjs
//
// 用法：
//   node scripts/reply.mjs --dry-run        # 预览
//   node scripts/reply.mjs                  # 按 config.reply.dryRun 决定
//   node scripts/reply.mjs --yes            # 强制真发
//   node scripts/reply.mjs --only <帖子ID>  # 只补一条

import { loadConfig, argvOf, sleep } from './lib/paths.mjs';
import { loadState, saveState, STATUS, REASON } from './lib/state.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { composeReply } from './lib/classify.mjs';
import { parseEmojiSegments } from './lib/emoji.mjs';
import { makeRunner, doctorOk, replyOne } from './lib/replier.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

const config = await loadConfig();
const dryRun = has('--yes') ? false : has('--dry-run') ? true : config.reply.dryRun !== false;
const onlyId = argOf('--only', null);

const qa = await loadQaLibrary(config.paths.qaFile);
const state = await loadState(config.paths.stateFile);

let todo = Object.entries(state.posts)
  .filter(([, p]) => p.status === STATUS.PENDING)
  .map(([id, p]) => ({ id, ...p }));
if (onlyId) todo = todo.filter((t) => t.id === String(onlyId));
todo = todo.slice(0, config.match.maxAutoReplyPerRun);

console.log(`[补发] dryRun=${dryRun}  待回复 ${todo.length} 条（上限 ${config.match.maxAutoReplyPerRun}）`);
if (!todo.length) process.exit(0);

const runner = makeRunner({ opencliMain: config.reply.opencliMain, session: config.reply.session });
if (!dryRun) {
  const d = doctorOk(runner);
  if (!d.ok) {
    console.error('[补发] opencli 不可用：' + d.text.split('\n')[0]);
    process.exit(2);
  }
}

for (const t of todo) {
  const entry = qa.find((e) => e.id === t.matchedQa);
  if (!entry) {
    console.log(`\n── ${t.title}\n   ⚠️ state 记录的 QA 已从库中删除，跳过`);
    continue;
  }
  const text = composeReply(entry, config);
  const { plainText, marks } = parseEmojiSegments(text);

  console.log(`\n── ${t.title}`);
  console.log(`   ${t.url}`);
  if (dryRun) {
    console.log(plainText.split('\n').map((l) => '     │ ' + l).join('\n'));
    if (marks.length) console.log('     │ 表情：' + marks.map((m) => `第${m.at}字后[表情_${m.name}]`).join('  '));
    continue;
  }
  const r = await replyOne({ runner, url: t.url, text, config, dryRun: false });
  if (r.ok) {
    state.posts[t.id].status = STATUS.REPLIED;
    state.posts[t.id].replied = true;
    state.posts[t.id].repliedAt = new Date().toISOString();
    console.log('   ✅ 已发送' + (r.detail?.emojis?.length ? `（表情 ${r.detail.emojis.join(',')}）` : ''));
  } else {
    state.posts[t.id].status = STATUS.MANUAL;
    state.posts[t.id].reason = r.stage === 'no_input' ? REASON.NO_INPUT : REASON.SEND_FAILED;
    console.log(`   ❌ 失败（${r.stage}）`);
  }
  await sleep(config.reply.delayMs ?? 6000);
}

await saveState(config.paths.stateFile, state);
console.log('\n[补发完成]');
