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
//   node scripts/api-write.mjs del-comment <commentId> [--yes]
//
// 签名：`reply` / `child` **默认自动补上** `config.reply.signature`（用户 2026-11-10：
//       「默认需要携带签名（在 LLM 后可以通过脚本添加）」）。要发不带签名的，加 `--no-signature`。
//
// ⚠️ `reply` / `child` 不传 --contents-json 时，交给 lib/taptap-api.mjs 自己建 contents ——
//    只有那条路会把 [表情_xx] 转成 tap_emoji 节点。自己用 buildContents() 拼纯文本，
//    表情就会变成字面文字「[表情_叹气]」发出去（2026-11-10 真踩到）。
//
// 选项：--session <name>（默认 config.reply.session）、--interval <ms>（默认 1000）

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunner } from './lib/replier.mjs';
import { makeTapApi } from './lib/taptap-api.mjs';
import { clampReply } from './lib/limits.mjs';

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

/**
 * 默认给文案补上签名（用户 2026-11-10）：
 *   「默认需要携带签名（在 LLM 后可以通过脚本添加）」+「LLM 就不带签名了，要不然重复」
 *
 * 签名**由脚本加**，不指望模型自己写。这里走的就是发送层同一套 `clampReply()`：
 *   · 已经带签名的不会再加一次（`includes` 判定）
 *   · 表情在结尾时，签名插在表情**前面**
 *   · 顺带按平台上限（1000）裁一刀
 * 要发不带签名的，显式加 `--no-signature`。
 */
function withSignature(text) {
  const sig = has('no-signature') ? '' : String(config?.reply?.signature || '').trim();
  return clampReply(text, { signature: sig });
}

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
    const text = withSignature(flag('text', ''));
    // 不自己拼 contents：让 api.reply 按 emoji-map 把 [表情_xx] 转成 tap_emoji 节点
    const contents = flag('contents-json');
    log(`计划：回复 ${id}\n  正文：${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
    if (!YES) {
      log('（未加 --yes，仅预览）');
      break;
    }
    const r = await api.reply({ momentId: id, text, contents });
    log(`结果：status=${r.status} ok=${r.ok} ${r.error || ''}${r.emojiHit ? ` emoji=${r.emojiHit}` : ''}`);
    log(`响应：${r.body.slice(0, 300)}`);
    if (r.ok) {
      const v = await api.hasReplyText({ momentId: id, text });
      log(`校验：评论已落库=${v.found}`);
    }
    break;
  }

  case 'child': {
    const text = withSignature(flag('text', ''));
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

  case 'del-comment': {
    // 删自己发错的回复（表情标记被当字面文本发出去那种）——只删评论，不动帖子
    log(`计划：删除评论 ${id}`);
    if (!YES) {
      log('（未加 --yes，仅预览）');
      break;
    }
    // 两个命名空间都试：新接口 moment-comment / 老接口 creation/comment
    const paths = ['/webapiv2/moment-comment/v1/delete', '/webapiv2/creation/comment/v1/delete'];
    for (const p of paths) {
      const r = await api.post(p, { id: String(id) });
      log(`  ${p} → status=${r.status} ok=${r.ok} ${r.error || ''}`);
      if (r.ok) {
        log(`  响应：${r.body.slice(0, 200)}`);
        break;
      }
      log(`  响应：${r.body.slice(0, 200)}`);
    }
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
