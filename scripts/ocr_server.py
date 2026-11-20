# -*- coding: utf-8 -*-
"""S3 本地 OCR 微服务（RapidOCR，2026-11-16）。

依赖：pip install rapidocr onnxruntime pillow numpy；/rerank 另需 pip install tokenizers
启动：python scripts/ocr_server.py [--port 8790] [--host 127.0.0.1]
接口：
  GET  /health        → {"ok": true, "engine": "rapidocr"}
  POST /ocr           ← {"image": "<base64>"}  → {"text": "...", "boxes": [{"text","conf"}]}
  POST /rerank        ← {"query", "candidates": [...], "modelDir"}  → {"scores": [...]}
      C4 cross-encoder（bge-reranker-v2-m3 ONNX，2026-11-17 P2 轮）。modelDir 需含
      model.onnx/model_quantized.onnx + tokenizer.json。lazy 加载，缺依赖只影响 /rerank。
说明：仅监听本地回环；图片由 Node 侧下载后传 base64（CDN 无防盗链）。
"""
import argparse
import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import cv2
    import numpy as np
    from PIL import Image
    from rapidocr import RapidOCR
except Exception as e:  # 缺依赖 → 启动即报错提示
    print("[ocr_server] 缺少依赖：%s\n请先 pip install rapidocr onnxruntime pillow numpy" % e, file=sys.stderr)
    raise

ENGINE = RapidOCR()


def ocr_array(arr):
    """跑 RapidOCR，兼容不同返回形态，抽出纯文本 + 置信度。"""
    result = ENGINE(arr)
    texts, boxes = [], []
    txts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if txts is not None:
        for i, t in enumerate(txts):
            if t:
                texts.append(str(t))
                conf = float(scores[i]) if scores is not None and i < len(scores) else None
                boxes.append({"text": str(t), "conf": conf})
    elif isinstance(result, (list, tuple)):
        for item in result:
            # 旧形态 [box, text, score]
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                t = item[1]
                if t:
                    texts.append(str(t))
                    boxes.append({"text": str(t), "conf": float(item[2]) if len(item) > 2 else None})
    return "\n".join(texts).strip(), boxes


def match_templates(scene, templates):
    """S6 模板匹配：多尺度 cv2.matchTemplate，返回 score>=threshold 的特征。
    templates: [{id, name, image(base64), threshold}]。场景与模板都转灰度匹配。"""
    scene_gray = cv2.cvtColor(scene, cv2.COLOR_RGB2GRAY)
    sh, sw = scene_gray.shape[:2]
    matches = []
    for tpl in templates:
        try:
            raw = base64.b64decode(tpl.get("image", ""))
            tarr = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"))
            tgray = cv2.cvtColor(tarr, cv2.COLOR_RGB2GRAY)
            threshold = float(tpl.get("threshold", 0.85))
            best, best_loc, best_scale = 0.0, None, 1.0
            for scale in (0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0):
                tw, th = int(tgray.shape[1] * scale), int(tgray.shape[0] * scale)
                if tw < 8 or th < 8 or tw > sw or th > sh:
                    continue
                resized = cv2.resize(tgray, (tw, th))
                res = cv2.matchTemplate(scene_gray, resized, cv2.TM_CCOEFF_NORMED)
                _, maxv, _, maxloc = cv2.minMaxLoc(res)
                if maxv > best:
                    best, best_loc, best_scale = maxv, maxloc, scale
            if best >= threshold:
                matches.append({
                    "id": tpl.get("id"), "name": tpl.get("name"),
                    "score": round(float(best), 3),
                    "loc": list(best_loc) if best_loc else None, "scale": best_scale,
                })
        except Exception:
            continue
    return matches


RERANK_SESSIONS = {}  # modelDir -> (session, tokenizer)，lazy 加载缓存


def get_reranker(model_dir):
    """C4：onnxruntime + tokenizers 加载 bge-reranker-v2-m3（cross-encoder）。"""
    if model_dir in RERANK_SESSIONS:
        return RERANK_SESSIONS[model_dir]
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
        raise FileNotFoundError("model.onnx/model_quantized.onnx not found in %s" % model_dir)
    tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
    tok.enable_truncation(max_length=512)
    tok.enable_padding()  # batch 内动态 pad
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    RERANK_SESSIONS[model_dir] = (sess, tok)
    return sess, tok


def rerank_scores(query, candidates, model_dir):
    """query×每个候选 配对打分，logits 越高越相关。"""
    import numpy as np
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
            self._send(200, {"ok": True, "engine": "rapidocr"})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path == "/rerank":
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                scores = rerank_scores(
                    payload.get("query", ""), payload.get("candidates", []), payload.get("modelDir", "")
                )
                self._send(200, {"ok": True, "scores": scores})
            except Exception as e:
                self._send(500, {"ok": False, "error": str(e)})
            return
        if path not in ("/ocr", "/match"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            b64 = payload.get("image", "")
            if not b64:
                self._send(400, {"ok": False, "error": "missing image"})
                return
            raw = base64.b64decode(b64)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            arr = np.asarray(img)
            if path == "/match":
                matches = match_templates(arr, payload.get("templates", []))
                self._send(200, {"ok": True, "matches": matches})
            else:
                text, boxes = ocr_array(arr)
                self._send(200, {"ok": True, "text": text, "boxes": boxes})
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("[ocr_server] RapidOCR 就绪，监听 http://%s:%d （/health /ocr）" % (args.host, args.port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()