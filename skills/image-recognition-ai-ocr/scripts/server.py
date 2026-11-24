# -*- coding: utf-8 -*-
"""image-recognition-ai-ocr 本地图像服务（OCR + 模板匹配）。

依赖：
    pip install rapidocr onnxruntime pillow numpy
    # 模板匹配另需 opencv（rapidocr 一般会带入；没有则 pip install opencv-python-headless）

启动：
    python scripts/server.py                 # 默认 127.0.0.1:8791
    python scripts/server.py --port 8791 --host 127.0.0.1

接口：
    GET  /health   → {"ok": true, "engine": "rapidocr", "opencv": true}
    POST /ocr      ← {"image": "<base64>"}
                   → {"ok": true, "text": "...", "boxes": [{"text","conf"}]}
    POST /match    ← {"image": "<base64>", "templates": [{"id","name","image","threshold"}]}
                   → {"ok": true, "matches": [{"id","name","score","loc","scale"}]}

设计说明：
    - 只监听本地回环；图片由调用方下载后传 base64（避免服务端去抓外网）。
    - OCR 与模板匹配共用本题像服务；**检索重排（rerank）不在这里** —— 那属检索能力，
      由调用方自己的服务提供（taptap 版主 skill 里是脚本 rerank_server.py，端口 8790）。
    - 模板库**不随本服务分发**，每次请求由调用方传入（各自领域的特征图）。
"""
import argparse
import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── 可选依赖：缺 opencv 时 /match 不可用，但 /ocr 仍可跑 ──
_HAS_CV2 = True
try:
    import cv2
except Exception:  # noqa: BLE001
    _HAS_CV2 = False
    cv2 = None

try:
    import numpy as np
    from PIL import Image
    from rapidocr import RapidOCR
except Exception as e:  # noqa: BLE001
    print(
        "[image-recognition-ai-ocr] 缺少依赖：%s\n"
        "请先 pip install rapidocr onnxruntime pillow numpy" % e,
        file=sys.stderr,
    )
    raise

ENGINE = RapidOCR()


def ocr_array(arr):
    """跑 RapidOCR，兼容不同返回形态，抽出纯文本 + 逐行置信度。"""
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
                    boxes.append(
                        {"text": str(t), "conf": float(item[2]) if len(item) > 2 else None}
                    )
    return "\n".join(texts).strip(), boxes


def match_templates(scene, templates):
    """多尺度模板匹配，返回 score >= threshold 的特征。

    templates: [{"id","name","image"(base64),"threshold"}]
    场景与模板都转灰度匹配；尺度范围放宽到 0.6~3.0，
    以支持"小模板（手机截图裁的图标）在大图上找到"。
    """
    if not _HAS_CV2:
        raise RuntimeError("未安装 opencv，/match 不可用：pip install opencv-python-headless")
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
                matches.append(
                    {
                        "id": tpl.get("id"),
                        "name": tpl.get("name"),
                        "score": round(float(best), 3),
                        "loc": list(best_loc) if best_loc else None,
                        "scale": best_scale,
                    }
                )
        except Exception:  # noqa: BLE001  单个模板坏掉不影响其它
            continue
    return matches


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
            self._send(200, {"ok": True, "engine": "rapidocr", "opencv": _HAS_CV2})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
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
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": str(e)})


def main():
    ap = argparse.ArgumentParser(description="image-recognition-ai-ocr 本地图像服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8791)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        "[image-recognition-ai-ocr] 就绪，监听 http://%s:%d （/health /ocr%s）"
        % (args.host, args.port, " /match" if _HAS_CV2 else "；未装 opencv，无 /match"),
        flush=True,
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()