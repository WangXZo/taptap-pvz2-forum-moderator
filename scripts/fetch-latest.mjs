// ★ 固定脚本：抓取论坛「按发布时间最新的 N 条」帖子
//
// 排序由接口负责：/feed/v7/by-group?sort=created 返回的就是**按发布时间严格降序**。
// 官方页面排序菜单的三个选项对应：
//   默认排序 → sort=default
//   回复时间 → sort=commented
//   发布时间 → sort=created   ← 本脚本使用
// 所以脚本只做「取回 + 截断 + 字段提取」，**不做任何本地排序**。
//
// 用法：
//   node scripts/fetch-latest.mjs
//   node scripts/fetch-latest.mjs --top 20
//   node scripts/fetch-latest.mjs --out latest.json
//   node scripts/fetch-latest.mjs --quiet      # 只输出 JSON，不打日志

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, argvOf } from './lib/paths.mjs';
import { listFeed, extractText, publishTime, activityTime, MOMENT_URL, WafBlocked } from './lib/http.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

const config = await loadConfig();
const TOP = Number(argOf('--top', config.collect.topN ?? 8));
const OUT = argOf('--out', null);
const QUIET = has('--quiet');

const SORT = config.collect.sort || 'created'; // created = 按发布时间降序

let data;
try {
  data = await listFeed({
    groupId: config.groupId,
    from: 0,
    limit: TOP, // 接口上限 10，够用
    sort: SORT,
    type: config.collect.type,
  });
} catch (e) {
  if (e instanceof WafBlocked) {
    console.error('[fetch] ⚠️ 被 WAF 拦截，请等待冷却后重试（别反复刷新）');
  } else {
    console.error(`[fetch] 失败：${e.message}`);
  }
  process.exit(1);
}

const items = data.list || [];

// 防御性校验：确认接口确实按发布时间降序返回；若异常则告警，但不本地重排
const times = items.map(publishTime);
const isDesc = times.every((t, i) => i === 0 || times[i - 1] >= t);
if (!QUIET) {
  console.error(`[fetch] 接口返回 ${items.length} 条（sort=${SORT}，total=${data.total}）`);
  if (!isDesc) {
    console.error('[fetch] ⚠️ 接口返回顺序与 sort=created 不符，疑似接口行为变更，请复核 sort 取值');
  }
}

const latest = items.slice(0, TOP).map((it) => {
  const m = it.moment || {};
  const { title, text } = extractText(it);
  return {
    id: String(m.id_str || ''),
    url: MOMENT_URL(m.id_str),
    title: title || text.slice(0, 40) || '(无标题)',
    text,
    author: m.author?.user?.name || '',
    authorId: String(m.author?.user?.id || ''),
    isModerator: !!m.author?.user?.is_moderator,
    publishTime: publishTime(it),
    commentedTime: activityTime(it),
    commentCount: Number(it.comment_count ?? m.stat?.comments ?? 0),
    groupLabel: m.group_label || null,
  };
});

if (OUT) {
  await writeFile(resolve(OUT), JSON.stringify(latest, null, 2), 'utf8');
  if (!QUIET) console.error(`[fetch] 已写入 ${OUT}`);
}

console.log(JSON.stringify(latest, null, 2));
