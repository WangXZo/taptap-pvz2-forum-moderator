// 统一配置测试（2026-11-20 · 阶段 3）
import {
  getPath, setPath, deepMerge, loadSchema, listFields, validateConfig,
  migrateLegacy, applyDefaults, applyEnv, resolveConfig, diffExtraKeys,
} from './lib/config.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n== getPath / setPath / deepMerge ==');
t('getPath 两层', getPath({ a: { b: 1 } }, 'a.b') === 1);
t('getPath 缺失 → undefined', getPath({}, 'a.b.c') === undefined);
t('getPath 中途 null 不炸', getPath({ a: null }, 'a.b') === undefined);
{
  const o = {};
  setPath(o, 'a.b.c', 42);
  t('setPath 自动建中间层', o.a.b.c === 42);
  setPath(o, 'a.b.c', 43);
  t('setPath 覆盖', o.a.b.c === 43);
}
t('deepMerge 深覆盖', eq(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 9 } }), { a: { b: 9, c: 2 } }));
t('deepMerge 数组整体替换', eq(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] }));
t('deepMerge 新增键', deepMerge({ a: 1 }, { b: 2 }).b === 2);
t('deepMerge 不带走 __ 前缀', deepMerge({ x: 1 }, { __m: 1 }).__m === undefined);
t('deepMerge b 为 undefined 保持 a', deepMerge({ a: 1 }, undefined).a === 1);

console.log('\n== schema 本身合法 ==');
const schema = loadSchema();
const fields = listFields(schema);
t('schema 能读', Object.keys(schema.groups || {}).length > 0);
t('字段数 > 80', fields.length > 80, `实际 ${fields.length}`);
t('每个字段都有 label', fields.every((f) => f.def.label), fields.filter((f) => !f.def.label).map((f) => f.path).join(','));
t('每个字段都有 type', fields.every((f) => f.def.type), fields.filter((f) => !f.def.type).map((f) => f.path).join(','));
t('每个字段都有 default', fields.every((f) => f.def.default !== undefined), fields.filter((f) => f.def.default === undefined).map((f) => f.path).join(','));
t('enum 字段的默认值在 enum 内', fields.filter((f) => f.def.enum).every((f) => f.def.enum.includes(f.def.default)),
  fields.filter((f) => f.def.enum && !f.def.enum.includes(f.def.default)).map((f) => f.path).join(','));

console.log('\n== migrateLegacy：双写 + 保留旧键 ==');
{
  const raw = { features: { image: true, weekly: false }, plugins: { praise: true, comfort: false } };
  const { moved, conflicts } = migrateLegacy(raw);
  t('迁移了 4 项', moved.length === 4, `实际 ${moved.length}`);
  t('新键 image.enabled=true', raw.image?.enabled === true);
  t('新键 weekly.enabled=false', raw.weekly?.enabled === false);
  t('新键 praise.enabled=true', raw.praise?.enabled === true);
  t('旧键仍保留（老代码还要读）', raw.features.image === true && raw.plugins.praise === true);
  t('无冲突', conflicts.length === 0);
}
{
  // comment 两处都有 → 只认 plugins.comment（等价于旧 loadPlugins 的「plugins 覆盖 features」）
  const raw = { features: { comment: false }, plugins: { comment: true } };
  const { moved } = migrateLegacy(raw);
  t('comment 只迁移一次', moved.length === 1, `实际 ${moved.length}`);
  t('comment.enabled 取 plugins 的值 true', raw.comment?.enabled === true, JSON.stringify(raw.comment));
  t('旧的 features.comment 原样保留', raw.features.comment === false);
}
{
  // codematch → codeMatch（大写 M），键名必须对齐真实 config
  const raw = { plugins: { codematch: true } };
  const { moved } = migrateLegacy(raw);
  t('codematch 迁移到 codeMatch.enabled', raw.codeMatch?.enabled === true, JSON.stringify(raw));
  t('不会写出小写 codematch', raw.codematch === undefined);
}
{
  // 新旧都写了且不一致 → 报冲突，新键优先，不覆盖
  const raw = { features: { weekly: false }, weekly: { enabled: true } };
  const { moved, conflicts } = migrateLegacy(raw);
  t('冲突被检出', conflicts.length === 1, JSON.stringify(conflicts));
  t('冲突时不覆盖新键', raw.weekly.enabled === true);
  t('冲突不计入 moved', moved.length === 0);
}
{
  // 都写了且一致 → 不算冲突也不算迁移
  const raw = { features: { image: true }, image: { enabled: true } };
  const { moved, conflicts } = migrateLegacy(raw);
  t('一致 → 无冲突', conflicts.length === 0);
  t('一致 → 无迁移', moved.length === 0);
}

console.log('\n== applyDefaults：只补缺失 ==');
{
  const cfg = { reply: { signature: '自定义签名' } };
  const { filled } = applyDefaults(cfg, schema);
  t('补了字段', filled.length > 0);
  t('缺失项被填上默认值', cfg.retrieve.topK === 8);
  t('已写的不被覆盖', cfg.reply.signature === '自定义签名');
  t('深路径也能填', cfg.exec.rateLimit.mode === 'adaptive');
  t('对象型默认值被深拷贝', (() => { cfg.reply.maxChars.post = 999; return schema.groups.reply.fields.maxChars.default.post === 130; })());
}

console.log('\n== applyEnv ==');
{
  const cfg = {};
  const { applied } = applyEnv(cfg, schema, {
    TAPTAP_CFG_REPLY_MAXCHARS: '200',
    TAPTAP_CFG_EXEC_WORKERPOOL_ENABLED: 'true',
    TAPTAP_CFG_LLM_DAILYCALLCAP: '50',
  });
  t('env 覆盖了字段', applied.length >= 2, JSON.stringify(applied.map((a) => a.path)));
  t('boolean 解析', cfg.exec.workerPool.enabled === true);
  t('integer 解析', cfg.llm.dailyCallCap === 50);
  t('未知键被忽略（不写脏值）', Object.keys(cfg).every((k) => ['exec', 'llm', 'reply'].includes(k)));
}

console.log('\n== validateConfig ==');
{
  const bad = {
    retrieve: { topK: 'many' },
    exec: { concurrency: 0 },
    pipeline: 'v9',
  };
  const issues = validateConfig(bad, schema);
  const paths = issues.map((i) => i.path);
  t('类型错误被报', paths.includes('retrieve.topK'), paths.join(','));
  t('范围错误被报', paths.includes('exec.concurrency'), paths.join(','));
  t('enum 错误被报', paths.includes('pipeline'), paths.join(','));
  t('全是 error 级', issues.every((i) => i.level === 'error'));
}
{
  const ok = { retrieve: { topK: 8 }, exec: { concurrency: 2 }, pipeline: 'v2' };
  t('合法配置无 issue', validateConfig(ok, schema).length === 0, JSON.stringify(validateConfig(ok, schema)));
}

console.log('\n== resolveConfig：端到端 ==');
{
  const raw = { features: { image: true, weekly: false }, reply: { signature: 'X' } };
  const logs = [];
  const cfg = resolveConfig(raw, { schema, log: (m) => logs.push(m), env: {} });
  t('默认值已补', cfg.retrieve.topK === 8);
  t('迁移已写入', cfg.image.enabled === true && cfg.weekly.enabled === false);
  t('用户值保留', cfg.reply.signature === 'X');
  t('meta 记录迁移数', cfg.__configMeta.migrated.length === 2, String(cfg.__configMeta.migrated.length));
  t('打印了迁移汇总', logs.some((l) => l.includes('旧键已迁移')), JSON.stringify(logs.slice(0, 3)));
  t('汇总是一行（不刷屏）', logs.filter((l) => l.includes('旧键已迁移')).length === 1);
}
{
  // 静默模式：不传 log 就不打印
  const cfg = resolveConfig({ features: { image: true } }, { schema, env: {} });
  t('无 log 时不打印（也不炸）', cfg.image.enabled === true);
}

console.log('\n== 真实 config.json 能通过 ==');
{
  const fs = await import('node:fs');
  const raw = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(raw);
  const cfg = resolveConfig(raw, { schema, env: {}, quiet: true });
  t('解析成功', Boolean(cfg.appId));
  t('appId 保留', Number(cfg.appId) === 54031);
  t('taptapCli 存在', cfg.taptapCli?.enabled === true);
  t('新增可配项已补上（reply.maxChars）', cfg.reply.maxChars?.post === 130);
  t('新增可配项已补上（exec.maxQueues）', cfg.exec.maxQueues === 32);
  t('新增可配项已补上（collect.childPageSize）', cfg.collect.childPageSize === 50);
  const issues = cfg.__configMeta.issues.filter((i) => i.level === 'error');
  t('真实配置校验无错', issues.length === 0, JSON.stringify(issues.slice(0, 5)));
}

console.log('\n== diffExtraKeys：发现漏写 schema 的键 ==');
{
  const cfg = { appId: 1, someNewGroup: { foo: 1 }, retrieve: { topK: 8 } };
  const extras = diffExtraKeys(cfg, schema);
  t('发现未定义分组', extras.some((p) => p.includes('someNewGroup')), JSON.stringify(extras));
  t('已定义字段不算 extra', !extras.includes('retrieve.topK'));
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);