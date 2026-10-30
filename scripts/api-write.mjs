#!/usr/bin/env node
// 接口直连手动工具（供人工核实 / 单条补操作）
//
// 与 mod-task 共用同一套 lib/taptap-api.mjs。写操作默认「只打印计划不执行」，
// 必须显式加 --yes 才真发，避免手滑。
//
// 用法：
//   node scripts/api-write.mjs auth
//   node scripts/api-write.mjs comments <momentId>
//   node scripts/api-write.mjs feed-has <momentId> --group 40173
//   node scripts/api-write.mjs has-text <momentId> --text "开头几个字"
//   node scripts/api-write.mjs reply  <momentId> --text "..." [--contents-json '[...]'] [--yes]
//   node scripts/api-write.mjs child  <momentId> --parent <commentId> --text "..." [--yes]
//   node scripts/api-write.mjs remove <momentId> --group 40173 [--yes]
//
// 选项：--session <name>（默认 config.reply.session）、--interval <ms>（默认 1000）

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner } from './lib/replier.mjs';
import { makeTapApi, buildContents } from './lib/taptap-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const config = JSON.parse(readFileSync(resolve(ROOT, 'scripts/config.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--yes'));
const [cmd, id] = positional;

const SESSION = flag('session', config.reply.session || 'tap');
const YES = has('yes');
const log = (s) => console.log(s);

const runner = makeRunner({ opencliMain: config.reply.opencliMain, session: SESSION });
if (!runner.available) {
  console.error(runner.reason);
  process.exit(1);
}
const api = makeTapApi({ runner, log, intervalMs: Number(flag('interval', 1000)) });

const o = api.ensureOrigin();
log(`页面：${o.url}${o.navigated ? '（已导航）' : ''}`);
const a = api.auth();
log(`凭据：${a.ok ? 'OK' : '缺失'}  uid=${a.uid ? a.uid.slice(0, 2) + '***' + a.uid.slice(-2) : '-'}`);
if (!a.ok) process.exit(2);

switch (cmd) {
  case 'auth':
    log(`X-UA: ${a.xua.replace(/VID=\d+/, 'VID=***')}`);
    break;

  case 'probe': {
    // 连通性自检：用不存在的假 id 打两个写接口，只会返回业务错误，不产生任何副作用
    const FAKE = '999999999999999999';
    log('— 探测 create（假 id，只会报错）');
    const r1 = await api.reply({ momentId: FAKE, text: 'probe' });
    log(`  status=${r1.status} ok=${r1.ok} err=${r1.error || '-'} body=${String(r1.body).slice(0, 220)}`);
    log('— 探测 unlink-group（假 id，只会报错）');
    const r2 = await api.remove({ momentId: FAKE, groupId: flag('group', '40173') });
    log(`  status=${r2.status} ok=${r2.ok} err=${r2.error || '-'} body=${String(r2.body).slice(0, 220)}`);
    break;
  }

  case 'comments': {
    const r = await api.comments({ momentId: id, limit: 30 });
    log(`total=${r.json?.data?.total ?? '?'}  list=${r.list.length}`);
    for (const c of r.list.slice(0, 10)) {
      const t = JSON.stringify(c.contents?.json || c.contents || '').replace(/\\[nrt]/g, ' ').slice(0, 80);
      log(`  [${c.id_str || c.id}] ${c.author?.name || '?'} :: ${t}`);
    }
    break;
  }

  case 'feed-has': {
    const g = flag('group', '40173');
    const r = await api.feedHas({ groupId: g, momentId: id });
    log(`group=${g} 仍在列表=${r.has}（扫描 ${r.scanned} 条）`);
    break;
  }

  case 'has-text': {
    const r = await api.hasReplyText({ momentId: id, text: flag('text', '') });
    log(`找到=${r.found}${r.id ? ` 评论id=${r.id}` : ''} total=${r.total ?? '?'}`);
    break;
  }

  case 'reply': {
    const text = flag('text', '');
    const contents = flag('contents-json') || buildContents(text);
    log(`计划：回复 ${id}\n  正文：${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
    if (!YES) {
      log('（未加 --yes，仅预览）');
      break;
    }
    const r = await api.reply({ momentId: id, text, contents });
    log(`结果：status=${r.status} ok=${r.ok} ${r.error || ''}`);
    log(`响应：${r.body.slice(0, 300)}`);
    if (r.ok) {
      const v = await api.hasReplyText({ momentId: id, text });
      log(`校验：评论已落库=${v.found}`);
    }
    break;
  }

  case 'child': {
    const text = flag('text', '');
    const parent = flag('parent', '');
    log(`计划：楼中楼回复 ${id} @ ${parent}\n  正文：${text.slice(0, 120)}`);
    if (!YES) {
      log('（未加 --yes，仅预览）');
      break;
    }
    const r = await api.childComment({ momentId: id, parentId: parent, text });
    log(`结果：status=${r.status} ok=${r.ok} ${r.error || ''}`);
    log(`响应：${r.body.slice(0, 300)}`);
    break;
  }

  case 'remove': {
    const g = flag('group', '40173');
    log(`计划：从板块 ${g} 移除 ${id}（= unlink，不删帖）`);
    if (!YES) {
      log('（未加 --yes，仅预览）');
      break;
    }
    const r = await api.remove({ momentId: id, groupId: g });
    log(`结果：status=${r.status} ok=${r.ok} ${r.error || ''}`);
    log(`响应：${r.body.slice(0, 300)}`);
    if (r.ok) {
      const v = await api.feedHas({ groupId: g, momentId: id });
      log(`校验：仍在列表=${v.has}（应=false）`);
    }
    break;
  }

  default:
    log('用法见文件头注释');
}
