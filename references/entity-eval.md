# P3（2026-11-18）：C8 多模态实体路由 + C9 评测 harness

> 配套 `lib/image-bridge.mjs`→能力包 `pvz2-image-recognition` 的 image.mjs(entities) / `lib/retrieve.mjs`(实体优先+最长匹配) / `lib/intent.mjs`(边界修) /
> `lib/eval.mjs` / `scripts/eval.mjs` / `assets/eval-set.json`。上游设计：实施方案报告 C8/C9。

## C8 多模态实体路由（图 → 知识直连）
- 链路：`matchFeatures` 命中模板 → `features:[names]` → `defaultRecognize.entities` →
  `enrichPostImages.entities` → plugin onPost → `collect post.imageEntities` →
  `retrieve` **实体优先 lookupFact**（active）→ fact 直连（score 1，`viaEntity:true`）。
- 兜底：实体未命中 facts → 回退文本提及/混合检索（识别文本已回灌 post.text）；
  **误识别防误套 = C7 verifyCandidate**（judge 不达标弃答），celebrate trigger 仍走庆祝动作。
- 文本提及路修：**最长匹配优先** + 用**原文**（rewrite 别名展开会造成泛名同长遮蔽，如「无尽」vs「摇滚无尽」）。

## C5 意图边界修（P3 检查/eval 发现）
- 问句里的「十连」是问规则 → 不算 celebrate（`looksLikeQuestion` 优先）。
- 「求攻略」含「攻略」被 `looksLikeQuestion` NOT_ASK 判非提问（collect 标记口径，不改）→
  intent 层游戏词表兜底仍走 qa。
- 非游戏 + 非问句 → chat（须在 looksLikeQuestion 前，它的「模糊默认提问」不该漏进 intent）；
  图片实体也算游戏相关。

## P3 评测驱动修（LLM 基线暴露，2026-11-18）
- **fact 不答该问别弃整帖**：fact 直连被 C7 judge 拒（如摇滚无尽 attrs 讲卡波、帖问阵容）→
  collect 用 `retrieve(..., {skipFacts:true})` 回退问答层重检+重判；仍不达标才弃答。
- **fact judge 循环论证修**：fact 且 attrs 非空 → faithfulness 恒 true（事实即资料），只信 relevance；
  纠正放在缓存读取后（旧缓存 faith=false 也立即纠正，免等 TTL）。
- 已知严判 case：tile-rare 回复补了资料外细节（2888 才出）→ C7 弃答属设计内；改善方向=补瓷砖萝卜 fact（需用户确认知识）。
- 流程规矩（用户 2026-11-18 明确）：**复制与守护进程生命周期分离**（robocopy 单独命令，不捆 watch 启动）；
  **编辑处理期间禁止执行**（改完再同步再跑）。

## C9 评测 harness（数据驱动迭代，轻量 JS 不引 RAGAS）
- 集：`assets/eval-set.json`（21 case：历史事故+已确认知识+意图边界+C8 实体）。新 bad-case 往里加。
- 指标：routeAcc / skipAcc / sourceAcc / **recall@5** / tierAcc / genOk / **tonePass**(口吻+护栏规则扫) / **faithPass**(LLM-judge)。
- 模式：规则模式零 LLM 成本；`--llm` 才跑 verify/compose/faith（每 case 各一次控费）。
- CLI：`node scripts/eval.mjs [--llm] [--dense char|bge] [--rerank llm|onnx] [--save-baseline] [--set f] [--out f]`
  （AB 对比换 dense/rerank；基线 data/eval-baseline.json 自动 diff；报告 reports/eval-<ts>.md+.json）。
  ⚠️ argvOf 约定裸参数名，CLI 入口已剥 `--` 前缀（ingest 同修）。
- 基线（2026-11-18 规则模式）：routeAcc/skipAcc/sourceAcc/recall5 = 1/1/1/1。
- 基线（2026-11-18 LLM 模式，回退修复+口径对齐后）：**21 case 全指标 1**
  （routeAcc/skipAcc/sourceAcc/recall5/tierAcc/genOk/tonePass/faithPass）。
  演进：首跑 tierAcc 0.667/faithPass 0.846 → 回退修复后 1/0.923 → eval 与 collect 回退口径对齐后 1/1。
  ⚠️ eval 必须与 collect 同口径（含 fact 被拒回退问答层），否则基线比 live 严、误导迭代。
- 回归：test-eval（toneScan + runEval 注入 stub + 报告渲染）进 npm test 链。