# 检索升级 P1（2026-11-17）：混合检索 + 重排 + 意图改写 + 增量摄入

> 配套 `lib/bm25.mjs` / `lib/hybrid.mjs` / `lib/rerank.mjs` / `lib/intent.mjs` / `lib/ingest.mjs` / `lib/retrieve.mjs` / `scripts/ingest.mjs`。
> v2 管线（`config.pipeline=v2`）已用本检索替换旧单路 matchPost。

## C3 混合检索 + RRF
- **BM25**（`bm25.mjs`，Okapi 纯 JS）：关键词路，补精确词/标识符（688/关卡号）。
- **dense**（P2 增强已接线）：`embed.mjs` ollama **bge-m3 真 embedding**（1024 维，本地免费），SQLite 缓存 `data/dense-cache.sqlite`（库向量只算一次，每轮只嵌 query）；`config.retrieve.denseBackend=bge`(默认)/`char`(强制零依赖)；ollama 不可用 → 自动 char-ngram coverage 兜底（`qa-vector.sparseVector/coverage`）。
- **RRF**（`hybrid.rrf`，k=60）融合两路排名定序；**分值归一 0-1**（0.6*BM25归一+0.4*dense）供 autoReplyScore/suggestScore 阈值。
- `hybridSearch(qa, query, {topK, dense})` → top-K 候选；`dense={q,docs}` 与 qa 同序时走余弦路。

## C4 重排
- `rerank.mjs` 双 backend（`config.rerank.backend`）：
  - `onnx`（**已启用** 2026-11-18）：本地 cross-encoder **bge-reranker-v2-m3**，走 `rerank_server.py /rerank`（onnxruntime+tokenizers，lazy 加载）；modelDir=`E:\Ollama\models\bge-reranker-v2-m3`（用户指定）。加载器优先 `model_quantized.onnx`＝fp16 原包本地转 fp32 产物（原 arnauld-a int8 包 fp16 图 CPU 不兼容，见 output/PVZ2-P1增强-模型下载教程-20261117.md 落地记录）；8 候选≈1s。
  - `llm`（默认过渡）：LLM listwise 精排（RankGPT-lite）。
  - 回退链：onnx→llm→RRF 原序（不阻断）。
- `config.retrieve.rerank=false` 可关。

## C5 意图分流 + query 改写
- `intent.intentOf`：code/celebrate/comfort/share/qa/chat（规则零成本）。
- `intent.rewriteQuery`：事实别名→规范名展开 + 去表情标记，提升 BM25/dense 召回；retrieve 已用。

## C11 增量摄入
- `ingest.ingest(items,{config,db})`：源(weekly/评论分析/沉淀/官方)→LLM 抽取{layer,entity,attrs,aliases,confidence}→facts+fact_sources→govern 自治治理。
- CLI：`node scripts/ingest.mjs --file <items.json> [--clear]`；items=[{text,source,url}]。增量由调用方按游标/去重喂新增。
- `config.features.ingest` 开关（插件化预留）。

## 验证
- 已知问题：688/双人对决→facts 精确(1.0)；阶数攻防/困难6→混合检索(0.63/0.70)。
- 测试：test-hybrid/test-rerank/test-intent/test-ingest/test-retrieve 全绿；全套无回归。