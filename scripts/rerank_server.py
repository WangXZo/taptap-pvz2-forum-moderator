# -*- coding: utf-8 -*-
"""taptap 版主 skill · 本地重排服务（cross-encoder）。

⚠️ 职责边界（2026-11-24 拆分）：
    本服务**只做检索重排**（/rerank）。
    OCR 与模板匹配已迁到独立 skill `image-recognition-ai-ocr` 的 scripts/server.py
    （默认端口 8791）。两者互不依赖，可各自独立启动。

    为什么拆：原来一个 ocr_server.py 同时提供 /ocr、/match、/rerank，
    前两个属「图片识别」、后一个属「检索」，混在一个进程里谁都不好复用。

依赖：
    pip install onnxruntime tokenizers
    （模型：bge-reranker-v2-m3，需含 model.onnx 或 model_quantized.onnx + tokenizer.json）

启动：
    python scripts/rerank_server.py                    # 默认 127.0.0.1:8790
    python scripts/rerank_server.py --port 8790

接口：
    GET  /health  → {"ok": true, "engine": "cross-encoder", "loaded": ["<modelDir>", ...]}
    POST /rerank  ← {"query": "...", "candidates": ["...", ...], "modelDir": "..."}
                  → {"ok": true, "scores": [0.12, -3.4, ...]}
"""
import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import numpy as np
except Exception as e:  # noqa: BLE001
    print("[rerank_server] 缺少依赖：%s\n请先 pip install onnxruntime tokenizers numpy" % e, file=sys.stderr)
    raise

SESSIONS = {}  # modelDir -> (session, tokenizer)，lazy 加载缓存


def get_reranker(model_dir):
    """onnxruntime + tokenizers 加载 cross-encoder（lazy，首次用才加载）。"""
    if model_dir in SESSIONS:
        return SESSIONS[model_dir]
    import os

    import onnxruntime as ort
    from tokenizers import Tokenizer

    onnx_path = None
    for name in ("model_quantized.onnx", "model_quant.onnx", "model.onnx"):
        p = os.path.join(model_dir or "", name)
        if os.path.exists(p):
            onnx_path = p
            break
    if not onnx_path:
        raise FileNotFoundError("model.onnx / model_quantized.onnx not found in %s" % model_dir)
    tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
    tok.enable_truncation(max_length=512)
    tok.enable_padding()
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    SESSIONS[model_dir] = (sess, tok)
    return sess, tok


def rerank_scores(query, candidates, model_dir):
    """query × 每个候选 配对打分，logits 越高越相关。"""
    sess, tok = get_reranker(model_dir)
    enc = tok.encode_batch([(query, c) for c in candidates])
    input_ids = np.array([e.ids for e in enc], dtype=np.int64)
    attention = np.array([e.attention_mask for e in enc], dtype=np.int64)
    feeds = {"input_ids": input_ids, "attention_mask": attention}
    names = [i.name for i in sess.get_inputs()]
    if "token_type_ids" in names:
        feeds["token_type_ids"] = np.zeros_like(input_ids)
    out = sess.run(None, feeds)[0]
    return [float(x) for x in out.reshape(-1)]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # 静音默认访问日志
        pass

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._send(200, {"ok": True, "engine": "cross-encoder", "loaded": list(SESSIONS.keys())})
        else:
            self._send(404, {"ok": False, "error": "not found", "hint": "本服务只有 /health 与 /rerank；OCR 在 image-recognition-ai-ocr（8791）"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path != "/rerank":
            hint = "本服务只有 /health 与 /rerank；OCR/模板匹配在 image-recognition-ai-ocr 的 server.py（8791）"
            self._send(404, {"ok": False, "error": "not found", "hint": hint})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            scores = rerank_scores(
                payload.get("query", ""), payload.get("candidates", []), payload.get("modelDir", "")
            )
            self._send(200, {"ok": True, "scores": scores})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": str(e)})


def main():
    ap = argparse.ArgumentParser(description="本地交叉编码器重排服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        "[rerank_server] 就绪，监听 http://%s:%d （/health /rerank）。"
        "OCR/模板匹配在 image-recognition-ai-ocr（8791）" % (args.host, args.port),
        flush=True,
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()