// TapTap 官方 CLI 封装（只读，2026-11-20）
//
// 为什么上官方 CLI：
//   旧通道（浏览器页面内 fetch `/webapiv2/moment/v3/detail`）有两个**平台级硬截断**：
//     ① `topic.summary` 只给 200 字（实测 5 种参数组合都一样，无全文字段）
//        → 我们曾经自己都说「正文断在这儿了？」，玩家还反问「是不是有读取字数限制」
//     ② `child_posts` 只返前 2 条，且 `by-comment` 400 / `child`、`by-parent` 404
//        → 我们自己发出去的子回复都读不到，幂等门一直在盲判
//   官方 CLI 的 `get-community-moment` / `list-community-moment-child-replies` 给全量。
//
// 实测事实（2026-11-20，详见 output/PVZ2-官方CLI调查结论-20261120.md）：
//   · `developer_id` 是**必填整数**，但服务端**不校验归属** → 填 1 就能读
//   · 写接口（create-reply / create-reply-child）要「论坛主管理员」，普通版主 403
//   · `--data` **必须传文件**（UTF-8 无 BOM）：PowerShell 管道/引号/Set-Content utf8 都会坏
//   · 输出里可能混进 node 的 stderr 告警 → 只取第一个 `{` 到最后一个 `}`
//
// 设计原则：**只读**。写继续走现有通道（opencli 页面内 fetch），opencli 保留为降级。
//   理由：写接口 403 未解；读写同时切会让失败面变大。

import { spawnSync, spawn as spawnChild } from 'node:child_process';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 从 CLI 输出里抠出 JSON 信封（stdout 可能混入 stderr 告警） */
export function pickEnvelope(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** 统一解包：{ok:true, data:{result}} → result；失败 → {ok:false, error} */
export function unwrap(env) {
  if (!env) return { ok: false, error: 'no_output', detail: 'CLI 无输出或输出非 JSON' };
  if (env.ok === false) {
    return {
      ok: false,
      error: env.error?.subtype || env.error?.type || 'cli_error',
      status: env.error?.code,
      message: env.error?.message || '',
    };
  }
  const d = env.data;
  if (!d) return { ok: false, error: 'no_data' };
  // 读接口统一是 {result:{...}}，兼容裸 result
  return { ok: true, result: d.result ?? d, status: d.status };
}

/**
 * @param {object} o
 * @param {string} [o.binary='taptap-cli']
 * @param {string} o.root           skill 根目录（临时文件放这里，因为 --data @path 必须在 cwd 内）
 * @param {number} [o.developerId=1] 官方 CLI 必填整数；实测不校验归属
 * @param {number} [o.timeoutMs=30000]
 * @param {Function} [o.log]
 * @param {Function} [o.spawn]      注入 spawnSync（测试用）
 */
export function createTapCli({
  binary = 'taptap-cli',
  root,
  developerId = 1,
  timeoutMs = 30000,
  log = () => {},
  spawn = spawnSync,
  /** 异步 spawn 注入点（测试用）；默认 node:child_process.spawn */
  spawnChild: spawnChildImpl = spawnChild,
} = {}) {
  const base = resolve(root || '.');
  const tmpDir = join(base, 'data', 'tmp');
  let seq = 0;

  /** 调用一次官方 CLI 操作 */
  function call(op, payload, { timeout = timeoutMs } = {}) {
    if (!existsSync(tmpDir)) {
      try { mkdirSync(tmpDir, { recursive: true }); } catch { /* 并发下可能已被建好 */ }
    }
    const name = `tt-${process.pid}-${Date.now()}-${(seq++).toString(36)}.json`;
    const rel = `data/tmp/${name}`;
    const abs = join(base, rel);
    // ⚠️ UTF-8 无 BOM：writeFileSync 默认就是这个，别用 PowerShell 的 Set-Content utf8（会带 BOM）
    writeFileSync(abs, JSON.stringify(payload), 'utf8');
    try {
      const args = [
        'community-management', op,
        '--app-id', String(payload.app_id ?? ''),
        '--data', `@${rel}`,
        '--json',
      ];
      // shell:true —— Windows 上 CLI 是 .ps1/.cmd 包装，不开 shell 找不到
      const r = spawn(binary, args, { cwd: base, encoding: 'utf8', timeout, shell: true });
      if (r?.error) {
        const msg = String(r.error.message || r.error);
        log(`  [CLI] ${op} 调用失败：${msg}`);
        return { ok: false, error: 'spawn_failed', message: msg };
      }
      if (r?.status !== 0) {
        const env = pickEnvelope(`${r?.stdout || ''}\n${r?.stderr || ''}`);
        const u = unwrap(env);
        if (!u.ok) {
          log(`  [CLI] ${op} 返回 ${r?.status}：${u.error}${u.message ? `（${u.message.slice(0, 120)}）` : ''}`);
        }
        return u.ok ? u : { ...u, exitCode: r?.status };
      }
      return unwrap(pickEnvelope(r?.stdout));
    } catch (e) {
      log(`  [CLI] ${op} 异常：${e.message}`);
      return { ok: false, error: 'exception', message: String(e?.message || e) };
    } finally {
      try { unlinkSync(abs); } catch { /* 临时文件清不掉无所谓 */ }
    }
  }

  const scope = (appId) => ({ app_id: String(appId), developer_id: Number(developerId) });

  /**
   * 异步调用（可并行）
   *
   * 为什么需要：`listThread` 要给每个一级回复补子回复，串行 spawnSync 时
   * 一帖 5 个回复就是 5 × ~1.5s = 7.5 秒（实测 fetch_comments 平均 1880ms 就是这么来的）。
   * 改成异步 spawn 后可以并发，N 个回复 ≈ 1.5s。
   *
   * 与同步 call 的关系：逻辑等价，只是不阻塞事件循环。失败语义一致。
   */
  function callAsync(op, payload, { timeout = timeoutMs } = {}) {
    return new Promise((resolvePromise) => {
      if (!existsSync(tmpDir)) {
        try { mkdirSync(tmpDir, { recursive: true }); } catch { /* 并发下可能已被建好 */ }
      }
      const name = `tt-${process.pid}-${Date.now()}-${(seq++).toString(36)}.json`;
      const rel = `data/tmp/${name}`;
      const abs = join(base, rel);
      try {
        writeFileSync(abs, JSON.stringify(payload), 'utf8');
      } catch (e) {
        return resolvePromise({ ok: false, error: 'tmp_write_failed', message: String(e?.message || e) });
      }
      const args = ['community-management', op, '--app-id', String(payload.app_id ?? ''), '--data', `@${rel}`, '--json'];
      let child;
      try {
        child = spawnChildImpl(binary, args, { cwd: base, shell: true });
      } catch (e) {
        try { unlinkSync(abs); } catch {}
        return resolvePromise({ ok: false, error: 'spawn_failed', message: String(e?.message || e) });
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (out) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { unlinkSync(abs); } catch {}
        resolvePromise(out);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        log(`  [CLI] ${op} 超时 ${timeout}ms`);
        finish({ ok: false, error: 'timeout', message: `超过 ${timeout}ms` });
      }, timeout);
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('error', (e) => finish({ ok: false, error: 'spawn_failed', message: String(e?.message || e) }));
      child.on('close', (code) => {
        const env = pickEnvelope(`${stdout}\n${stderr}`);
        const u = unwrap(env);
        if (code !== 0 && !u.ok) return finish({ ...u, exitCode: code });
        finish(u);
      });
    });
  }

  return {
    raw: call,

    /** 论坛发现：按 app 精确查（不需要 dev_id 校验） */
    searchForums({ appId }) {
      return call('search-community-forums', { app_id: String(appId) });
    },

    /** 帖子列表：order=published|commented，intent=1 问答 / 2 反馈 */
    listMoments({ appId, order = 'published', page = 1, pageSize = 20, intent = null, groupLabelId = null }) {
      const p = { ...scope(appId), order, page, page_size: pageSize };
      if (intent) p.moment_intent = Array.isArray(intent) ? intent.map(Number) : [Number(intent)];
      if (groupLabelId) p.group_label_id = String(groupLabelId);
      return call('list-community-moments', p);
    },

    /**
     * 帖子详情：**`content` 是全文**（旧接口 summary 只有 200 字）
     * @returns {{ok, result:{content, summary, moment}}}
     */
    getMoment({ appId, momentId }) {
      return call('get-community-moment', { ...scope(appId), moment_id: String(momentId) });
    },

    /** 一级回复列表（total 准确，支持分页） */
    listReplies({ appId, momentId, page = 1, pageSize = 50 }) {
      return call('list-community-moment-replies', {
        ...scope(appId), moment_id: String(momentId), page, page_size: pageSize,
      });
    },

    /**
     * 子回复列表：**total 全量**（旧接口 child_posts 只给 2 条）
     * @param {string} parentReplyId 一级回复的 comment_id
     */
    listChildReplies({ appId, momentId, parentReplyId, page = 1, pageSize = 50 }) {
      return call('list-community-moment-child-replies', {
        ...scope(appId), moment_id: String(momentId),
        parent_reply_id: String(parentReplyId), page, page_size: pageSize,
      });
    },

    /** 子版块列表 */
    listGroupLabels({ appId }) {
      return call('list-community-group-labels', scope(appId));
    },

    /**
     * 拉全一帖的「一级回复 + 全部子回复」
     * 为什么要这个：旧通道子回复只给 2 条，导致 ①我们缺席 ②幂等门盲判 ③漏读关键答案
     * @returns {{ok, replies:Array, total, childTotal}}
     */
    async listThread({ appId, momentId, pageSize = 50, maxPages = 8, childConcurrency = 4 }) {
      const all = [];
      let total = 0;
      for (let page = 1; page <= maxPages; page++) {
        const r = this.listReplies({ appId, momentId, page, pageSize });
        if (!r.ok) return { ok: false, error: r.error, message: r.message, replies: all };
        const list = r.result?.list || [];
        total = Number(r.result?.total ?? total);
        all.push(...list);
        if (!list.length || all.length >= total) break;
      }
      // 逐条补齐子回复
      //   ⚠️ 这里过去是**串行 spawnSync**：一帖 5 个一级回复 = 5 × ~1.5s = 7.5 秒。
      //   实测 fetch_comments 平均 1880ms 主要就是这个。改成并发（默认 4）后 N 个回复 ≈ 1.5s。
      let childTotal = 0;
      const parents = all.filter((c) => c && c.comment_id);
      if (parents.length) {
        const CONCURRENCY = Math.max(1, Number(childConcurrency) || 4);
        let cursor = 0;
        const worker = async () => {
          while (cursor < parents.length) {
            const c = parents[cursor++];
            const cid = String(c.comment_id);
            const kids = [];
            for (let page = 1; page <= maxPages; page++) {
              const r = await callAsync('list-community-moment-child-replies', {
                ...scope(appId),
                moment_id: String(momentId),
                parent_reply_id: cid,
                page,
                page_size: pageSize,
              });
              if (!r.ok) break;
              const list = r.result?.list || [];
              kids.push(...list);
              const t = Number(r.result?.total ?? 0);
              if (!list.length || kids.length >= t) break;
            }
            c.child_replies = kids;
            childTotal += kids.length;
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parents.length) }, worker));
      }
      return { ok: true, replies: all, total, childTotal };
    },

    /** CLI 是否可用（安装 + 登录），供 readiness / doctor 用 */
    available() {
      const r = spawn(binary, ['auth', 'status'], { encoding: 'utf8', timeout: 20000, shell: true });
      if (r?.error || r?.status !== 0) {
        return { ok: false, error: 'cli_unavailable', detail: String(r?.error?.message || r?.stderr || '').slice(0, 200) };
      }
      const txt = String(r?.stdout || '');
      const logged = /Bearer:\s*有效|有效（|authenticated":\s*true/i.test(txt);
      return { ok: Boolean(logged), error: logged ? undefined : 'not_logged_in', detail: txt.slice(0, 200) };
    },
  };
}