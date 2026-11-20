// P4-b 摄入测试（2026-11-19）：源适配器增量 + 游标 + 插件 scheduled
import { htmlToText, fetchOfficial, fetchWeekly, collectSources } from './lib/ingest-sources.mjs';
import ingestPlugin from './plugins/ingest.mjs';
import { openDb } from './lib/db.mjs';
import { listFacts } from './lib/facts.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== htmlToText ==');
t('去脚本/样式', !htmlToText('<script>var a=1</script><p>正文</p>').includes('var a'));
t('去标签保文本', htmlToText('<div><p>你好</p><p>世界</p></div>').includes('你好') && htmlToText('<p>a</p><p>b</p>').includes('b'));
t('实体解码', htmlToText('&amp; &lt; &gt;').includes('&'));
t('压空白', !/\s{2,}/.test(htmlToText('a\n\n\n   b')));
t('截断 maxChars', htmlToText('x'.repeat(100), { maxChars: 10 }).length === 10);

console.log('\n== fetchOfficial（游标增量）==');
{
  const cfg = { urls: ['https://a/1', 'https://a/2'], maxChars: 200 };
  const fetchImpl = async (u) => `<html><body><article>${u} 的官方公告正文内容，这是一段足够长的说明文字用于测试，包含足够的字符以免被最短长度阈值过滤掉。</article></body></html>`;
  const r1 = await fetchOfficial(cfg, {}, { fetchImpl });
  t('首次两条都抓', r1.items.length === 2);
  t('游标记录 seen', r1.cursor.seen.length === 2);
  t('source 带官方前缀', r1.items[0].source.startsWith('官方:'));
  const r2 = await fetchOfficial(cfg, r1.cursor, { fetchImpl });
  t('二次无新增（游标生效）', r2.items.length === 0);
  // 新增一条 url → 只抓新的
  const r3 = await fetchOfficial({ ...cfg, urls: [...cfg.urls, 'https://a/3'] }, r1.cursor, { fetchImpl });
  t('新增 url 只抓增量', r3.items.length === 1 && r3.items[0].url === 'https://a/3');
  // 抓取失败不影响其他
  const r4 = await fetchOfficial({ urls: ['https://bad', 'https://ok'] }, {}, { fetchImpl: async (u) => { if (u.includes('bad')) throw new Error('boom'); return '<p>' + 'x'.repeat(80) + '</p>'; } });
  t('单条失败被隔离', r4.items.length === 1);
}

console.log('\n== fetchWeekly（按文件增量）==');
{
  const dir = mkdtempSync(join(tmpdir(), 'wk-'));
  writeFileSync(join(dir, '论坛周报-2026-11-10.md'), '# 周报\n\n' + '这是一周的玩家提问与吐槽分类总结内容。'.repeat(5));
  writeFileSync(join(dir, 'other.md'), '不该被摄入');
  const r1 = fetchWeekly({ enabled: true }, {}, { dir });
  t('只摄周报 md', r1.items.length === 1 && r1.items[0].source.startsWith('周报:'));
  t('不摄其他文件', !r1.items.some((x) => String(x.source).includes('other')));
  const r2 = fetchWeekly({ enabled: true }, r1.cursor, { dir });
  t('二次无新增', r2.items.length === 0);
  writeFileSync(join(dir, '论坛周报-2026-11-17.md'), '# 周报2\n\n' + '第二周的总结内容。'.repeat(8));
  const r3 = fetchWeekly({ enabled: true }, r1.cursor, { dir });
  t('新增文件被增量抓到', r3.items.length === 1 && String(r3.items[0].source).includes('11-17'));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n== collectSources 多源合并 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'wk2-'));
  writeFileSync(join(dir, '论坛周报-2026-11-18.md'), '# 周报\n\n' + '内容'.repeat(40));
  const config = { ingest: { sources: { official: { enabled: true, urls: ['https://x/1'] }, weekly: { enabled: true } } }, paths: { reportsDir: dir } };
  const r = await collectSources(config, {}, { fetchImpl: async () => '<p>' + 'official '.repeat(20) + '</p>', weeklyDir: dir });
  t('两源内容合并', r.items.length === 2);
  t('bySource 统计', r.bySource.official === 1 && r.bySource.weekly === 1);
  t('游标分别记录', Boolean(r.cursors.official?.seen?.length && r.cursors.weekly?.seen?.length));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n== ingest 插件 scheduled ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'ing-'));
  const db = openDb(join(dir, 'rec.sqlite'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const wk = join(dir, 'reports');
  mkdirSync(wk, { recursive: true });
  writeFileSync(join(wk, '论坛周报-2026-11-19.md'), '# 周报\n\n' + '玩家集中反馈：瓷砖萝卜稀有，2888 传奇宝箱十连出。'.repeat(4));
  const config = {
    paths: { dataDir, reportsDir: wk, postDbFile: join(dir, 'rec.sqlite') },
    ingest: { enabled: true, sources: { weekly: { enabled: true } } },
    // ⚠️ 必须显式关掉 LLM：否则会真的去撞渠道（25s 超时 × 多渠道）。
    //   在配置了凭据的环境里（如 live）会留下未收尾的请求，进程退出时触发
    //   libuv 断言 `UV_HANDLE_CLOSING` 直接崩（实测 3/3 复现）。
    llm: { enabled: false, usagePersist: false },
  };
  // 关闭时不做任何事
  const r0 = await ingestPlugin.scheduled({ config: { ...config, ingest: { enabled: false } }, log: () => {}, db });
  t('enabled=false → 不摄入', r0.items === 0);
  // dry-run 不写入、不推进游标
  const rd = await ingestPlugin.scheduled({ config, log: () => {}, db, dryRun: true, weeklyDir: wk });
  t('dry-run 抓到但不写', rd.items >= 1 && rd.dryRun === true);
  {
    const cp = join(dataDir, 'ingest-cursor.json');
    const advanced = existsSync(cp) && readFileSync(cp, 'utf8').includes('11-19');
    t('dry-run 未推进游标', advanced === false);
  }
  // 正常跑（LLM 抽取会失败 → stat.fail，但不崩、游标不推进）
  const r1 = await ingestPlugin.scheduled({ config, log: () => {}, db, weeklyDir: wk });
  t('正常跑不崩', typeof r1.items === 'number' && r1.items >= 1);
  t('无 db → 安全返回', (await ingestPlugin.scheduled({ config, log: () => {}, db: null })).error === 'no_db');
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);