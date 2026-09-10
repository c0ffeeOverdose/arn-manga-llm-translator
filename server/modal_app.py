# Modal deployment of server/app.py: T4 GPU, scale-to-zero, Bearer auth.
# Deploy from inside server/: modal deploy modal_app.py
# (needs MODAL_TOKEN_ID/SECRET). app.py bakes into the image — each deploy
# is immutable, no runtime mounts.
import os
import sys

import modal

sys.path.insert(0, os.environ.get("PKG_DIR", os.path.dirname(os.path.abspath(__file__))))
# NOTE: top-level sibling import — resolved locally at deploy parse time
# (needs the full deps installed where you deploy from), baked copy used remotely.
from app import app as fastapi_app

CTD_URL = ("https://huggingface.co/lemondouble/lemon-manga-translator"
           "/resolve/main/onnx/comic-text-detector/ctd.onnx?download=true")
BABERU = "https://huggingface.co/genshiai-daichi/baberu-ocr/resolve/main"
BABERU_FILES = [
    ("onnx/vision_int4.onnx", "vision-int4.onnx"),
    ("onnx/decoder_prefill_int8.onnx", "baberu-prefill.onnx"),
    ("onnx/decoder_step_int8.onnx", "baberu-step.onnx"),
    ("tokenizer/vocab.json", "vocab.json"),
]

dl = [f"mkdir -p /models",
      f'curl -fL -o /models/ctd.onnx "{CTD_URL}"']
dl += [f'curl -fL -o /models/{dst} "{BABERU}/{src}?download=true"'
       for src, dst in BABERU_FILES]

image = (
    # nvidia runtime base: onnxruntime-gpu needs CUDA 13 + cuDNN 9 system
    # libs (libcublasLt.so.13) that debian_slim lacks — plain pip is not enough
    modal.Image.from_registry("nvidia/cuda:13.0.2-cudnn-runtime-ubuntu24.04",
                              add_python="3.12")
    .apt_install("curl")
    .pip_install("fastapi", "uvicorn[standard]", "onnxruntime-gpu",
                 "numpy", "pillow", "opencv-python-headless")
    .env({"ORT_PROVIDERS": "CUDAExecutionProvider,CPUExecutionProvider",
          "ORT_DEVICE": "cuda", "PKG_DIR": "/pkg"})
    .run_commands(*dl)
    # single file, not add_local_dir("."): deploy sources like Colab's /content
    # hold mutating internal files (.config/gce) that abort the build mid-snapshot
    .add_local_file("app.py", remote_path="/pkg/app.py")
)

app = modal.App("arn-manga")


@app.function(image=image, gpu=["T4", "L4"], timeout=600,
              secrets=[modal.Secret.from_name("arn-manga-key")])
@modal.asgi_app()
def api():
    import os

    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    key = os.environ["ARN_API_KEY"]

    class Auth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.url.path in ("/", "/health"):
                return await call_next(request)
            if request.headers.get("authorization") != f"Bearer {key}":
                return JSONResponse({"ok": False, "error": "unauthorized"}, 401)
            return await call_next(request)

    fastapi_app.add_middleware(Auth)
    return fastapi_app
