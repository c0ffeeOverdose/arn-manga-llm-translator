# Modal deployment of server/app.py: T4/L4 GPU, scale-to-zero, proxy auth. Deploy from inside server/.
# app.py bakes into the image — each deploy is immutable, no runtime mounts.
import os
import sys

import modal

sys.path.insert(0, os.environ.get("PKG_DIR", os.path.dirname(os.path.abspath(__file__))))
# NOTE: sibling import resolved locally at deploy parse time; baked copy used remotely.
from app import app as fastapi_app
from models_manifest import CTD_URL, KOHARU_FILE, KOHARU_URL, KOHARU_SHA256, BABERU, BABERU_FILES, INPAINT_URL

dl = [f"mkdir -p /models",
      f'curl -fL -o /models/ctd.onnx "{CTD_URL}"',
      f'curl -fL -o /models/{KOHARU_FILE} "{KOHARU_URL}"',
      f'echo "{KOHARU_SHA256}  /models/{KOHARU_FILE}" | sha256sum -c -']
dl += [f'curl -fL -o /models/{dst} "{BABERU}/{src}?download=true"'
       for src, dst in BABERU_FILES]
dl.append(f'curl -fL -o /models/lama-manga-512-fp16w.onnx "{INPAINT_URL}"')

image = (
    # nvidia runtime base: onnxruntime-gpu needs CUDA 13 + cuDNN 9 system libs plain pip lacks.
    # Pin the wheel: a newer CUDA requirement would silently fall back to CPU on a GPU bill.
    modal.Image.from_registry("nvidia/cuda:13.0.2-cudnn-runtime-ubuntu24.04",
                              add_python="3.12")
    .apt_install("curl")
    .pip_install("fastapi", "uvicorn[standard]", "onnxruntime-gpu==1.30.0",
                 "numpy", "pillow", "opencv-python-headless")
    .env({"ORT_PROVIDERS": "CUDAExecutionProvider,CPUExecutionProvider",
          "ORT_DEVICE": "cuda", "PKG_DIR": "/pkg"})
    .run_commands(*dl)
    # single file, not add_local_dir: deploy sources can hold mutating files that abort the build
    .add_local_file("app.py", remote_path="/pkg/app.py")
    .add_local_file("split.py", remote_path="/pkg/split.py")
    .add_local_file("balloon_surface.py", remote_path="/pkg/balloon_surface.py")
    .add_local_file("koharu.py", remote_path="/pkg/koharu.py")
    # the container re-imports modal_app.py, which imports this
    .add_local_file("models_manifest.py", remote_path="/pkg/models_manifest.py")
)

app = modal.App("arn-manga")


# scaledown_window=90: reading bursts run nonstop; 90s covers page-to-page pauses without a long idle tail.
@app.function(image=image, gpu=["T4", "L4"], timeout=600, scaledown_window=90,
              min_containers=0, max_containers=1)
@modal.asgi_app(requires_proxy_auth=True)
def api():
    return fastapi_app
