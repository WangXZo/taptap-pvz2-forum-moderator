// 回复执行器：通过 opencli 驱动已登录的 Chrome，打开帖子 → 填正文 → 点选表情 → 发送
//
// 关键实现说明：
//  1) 用 `node <opencli main.js>` 直接调 opencli，而不是走 opencli.ps1/.cmd。
//     原因：Windows 下 .ps1 wrapper 会把带空格/引号的 JS 参数重新拆开，
//     用 execPath + 数组参数传递才能稳定携带复杂 JS。
//  2) 表情必须「点选」：直接输入 [表情_开心] 只会变成纯文本（已实测）。
//  3) fill / type 对编辑器是整体替换，点选表情是追加到末尾
//     → 因此文案里的表情只能放在结尾。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEmojiSegments, applyEmojis } from './emoji.mjs';
import { getTapApi, momentIdFromUrl, stripEmojiMarks } from './taptap-api.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 自动探测 opencli 的 JS 入口 */
export function resolveOpencliMain(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.OPENCLI_MAIN) cands.push(process.env.OPENCLI_MAIN);

  const rel = 'node_modules/@jackwener/opencli/dist/src/main.js';
  const roots = [];
  // 常见全局安装位置
  if (process.env.APPDATA) roots.push(resolve(process.env.APPDATA, 'npm'));
  roots.push(resolve(homedir(), 'AppData/Roaming/npm'));
  roots.push('D:\\npm-global', 'C:\\npm-global');
  // npm prefix 邻近目录
  const execDir = resolve(process.execPath, '..');
  roots.push(execDir, resolve(execDir, '..'));

  // npm root -g 的结果（可能被沙盒拦，忽略失败）
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000, shell: true });
    const out = (r.stdout || '').trim();
    if (out) roots.push(out);
  } catch {}

  for (const root of roots) cands.push(resolve(root, rel));

  for (const c of cands) {
    try {
      if (c && existsSync(c)) return c;
    } catch {}
  }
  return null;
}

export function makeRunner({ opencliMain, session = 'tap' } = {}) {
  const MAIN = resolveOpencliMain(opencliMain);
  if (!MAIN) {
    return {
      available: false,
      reason:
        '找不到 opencli 入口。请安装：npm i -g @jackwener/opencli，或在 config.json 里配置 reply.opencliMain 指向 dist/src/main.js',
    };
  }
  const oc = (args, { timeout = 60000 } = {}) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', timeout });
    const out = `${r.stdout || ''}`;
    const err = `${r.stderr || ''}`;
    let json = null;
    const m = out.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        json = JSON.parse(m[0]);
      } catch {}
    }
    return { code: r.status, out, err, text: out + err, json, spawnError: r.error?.message };
  };
  return { available: true, main: MAIN, oc, session };
}

export function doctorOk(runner) {
  if (!runner.available) return { ok: false, text: runner.reason };
  const d = runner.oc(['doctor'], { timeout: 45000 });
  return { ok: /Extension:\s*connected/.test(d.text), text: d.text };
}

/** 找可见的编辑器输入框 */
function findEditor(runner) {
  const r = runner.oc(['browser', runner.session, 'find', '--css', '[contenteditable=true]']);
  const ents = (r.json?.entries || []).filter((e) => e.visible === true);
  return ents[0] || null;
}

/** 找发送按钮 */
function findSendButton(runner) {
  for (const sel of ['button', '[class*=send]', '[class*=submit]']) {
    const r = runner.oc(['browser', runner.session, 'find', '--css', sel]);
    const list = (r.json?.entries || []).filter((e) => e.visible !== false);
    const hit = list.find(
      (e) => (e.text || '').trim() === '发送' || (e.attrs?.class || '').toLowerCase().includes('send')
    );
    if (hit) return hit;
  }
  const r = runner.oc(['browser', runner.session, 'find', '--role', 'button', '--name', '发送']);
  return (r.json?.entries || []).find((e) => e.visible !== false) || null;
}

/** 读编辑器当前纯文本 */
function readEditorText(runner) {
  const js = `(()=>{const d=document.querySelector('.tap-editor-compact__content');return d?d.innerText:''})()`;
  const r = runner.oc(['browser', runner.session, 'eval', js], { timeout: 30000 });
  const m = r.text.match(/'((?:[^'\\]|\\.)*)'/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {}
  }
  return r.text;
}

/**
 * 校验正文是否真的写进去了。
 * 不用 opencli 的 verified：多行文本时它会把段落换行算进差异，误判 false
 * （实测内容其实完全正确，是 <p>a</p><p><br></p><p>b</p> 三段结构）。
 * 改为读编辑器 innerText，逐行比对关键片段。
 */
function verifyTextWritten(runner, expect) {
  const got = readEditorText(runner) || '';
  const norm = (s) => String(s).replace(/\s+/g, '');
  const g = norm(got);
  const chunks = String(expect)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chunks.length) return { ok: true, got };
  const missing = chunks.filter((c) => !g.includes(norm(c)));
  return { ok: missing.length === 0, got, missing };
}

/**
 * 回复一条帖子
 * @returns {{ok:boolean, stage:string, detail?:any}}
 */
export async function replyOne({
  runner,
  url,
  text,
  config,
  dryRun = false,
  log = () => {},
}) {
  const { plainText, marks } = parseEmojiSegments(text);

  if (dryRun) {
    return { ok: true, stage: 'dry_run', detail: { url, body: plainText, marks } };
  }
  if (!runner?.available) {
    return { ok: false, stage: 'opencli_missing', detail: runner?.reason };
  }

  // ---- 接口直连优先（用户 2026-10-30：答疑也直接打接口）----
  //   比点 UI 快得多、不受 DOM 改版影响；失败自动退回下面的 UI 流程。
  //   接口回复是纯文本 → 表情标记先剥掉（tap_emoji 节点格式另行验证后再启用）。
  if (String(config?.reply?.via || 'api').toLowerCase() !== 'ui') {
    const api = getTapApi({ runner, log, intervalMs: Number(config?.reply?.apiIntervalMs ?? 6000) });
    const momentId = momentIdFromUrl(url);
    if (momentId && api.ensureOrigin().ok) {
      // 文案原样传进去：接口层会把 [表情_xx] 转成 tap_emoji 节点（查表 data/emoji-map.json）
      const ar = await api.reply({ momentId, text });
      if (ar.ok) {
        const plain = stripEmojiMarks(text).trim();
        const v = await api.hasReplyText({ momentId, text: plain });
        log(
          `      [接口] 已回复（表情 ${ar.emojiHit || 0} 个）` +
            (v.found ? '（已校验落库）' : '（未校验到，按成功处理）')
        );
        return { ok: true, stage: 'api_sent', detail: { verified: v.found, body: plain, marks, emoji: ar.emojiHit } };
      }
      log(`      [接口] 回复失败（${ar.status}${ar.error ? ' ' + ar.error : ''}）→ 退回 UI 流程`);
    }
  }

  const S = runner.session;

  // 1. 打开帖子
  const open = runner.oc(['browser', S, 'open', url], { timeout: 90000 });
  if (open.code !== 0) return { ok: false, stage: 'open', detail: open.text.slice(0, 200) };
  await sleep(4500);

  // 2. 填正文（一次性填完整纯文字，表情标记已剥离）
  const ed = findEditor(runner);
  if (!ed) return { ok: false, stage: 'no_input', detail: '未找到回复输入框' };

  if (plainText) {
    const f = runner.oc(['browser', S, 'fill', String(ed.ref), plainText]);
    await sleep(700);
    const v = verifyTextWritten(runner, plainText);
    if (!v.ok) {
      return {
        ok: false,
        stage: 'fill',
        detail: { missing: v.missing, actual: (v.got || '').slice(0, 200) },
      };
    }
  }

  // 3. 按位置插入表情（fill 全文 → 光标定位 → 点选，从后往前）
  let emojiResult = null;
  if (marks.length) {
    emojiResult = await applyEmojis(runner.oc, S, ed.ref, marks, { sleep, log });
    log(
      `      表情：成功 ${emojiResult.done.length}/${marks.length}` +
        (emojiResult.missed.length ? `，失败 ${emojiResult.missed.map((x) => x.name).join(',')}` : '')
    );
    // 安全阀：表情没插全就不发，转人工，避免发出错误内容
    if (emojiResult.missed.length) {
      return {
        ok: false,
        stage: 'emoji',
        detail: { missed: emojiResult.missed, done: emojiResult.done },
      };
    }
    await sleep(800);
  }

  // 4. 发送
  const send = findSendButton(runner);
  if (!send) return { ok: false, stage: 'no_send_button', detail: '找不到发送按钮，已中止（不盲点）' };

  const c = runner.oc(['browser', S, 'click', String(send.ref)], { timeout: 30000 });
  if (c.code !== 0) return { ok: false, stage: 'send_click', detail: c.text.slice(0, 200) };
  await sleep(3500);

  // 5. 校验：发完编辑器应清空
  const html = runner.oc([
    'browser',
    S,
    'eval',
    `(()=>{const d=document.querySelector('.tap-editor-compact__content');return d?d.innerHTML.slice(0,200):'NONE'})()`,
  ]);
  const cleared = /is-empty|is-editor-empty/.test(html.text);

  runner.oc(['browser', S, 'close']);
  return {
    ok: true,
    stage: 'sent',
    detail: {
      cleared,
      emojis: emojiResult?.done || [],
      emojiMissed: emojiResult?.missed || [],
    },
  };
}

