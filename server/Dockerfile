# HuggingFace Docker Space image: CPU-only FastAPI (port 7860).
# Weights bake into the image at build time (Spaces have no persistent disk
# on the free tier — downloading at runtime would re-fetch on every wake).
FROM python:3.12-slim
ENV MODEL_DIR=/models PORT=7860
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir fastapi "uvicorn[standard]" onnxruntime numpy pillow opencv-python-headless
WORKDIR /app
COPY app.py .
RUN mkdir -p /models \
  && curl -fL -o /models/ctd.onnx \
    "https://huggingface.co/lemondouble/lemon-manga-translator/resolve/main/onnx/comic-text-detector/ctd.onnx?download=true" \
  && for f in "onnx/vision_int4.onnx vision-int4.onnx" "onnx/decoder_prefill_int8.onnx baberu-prefill.onnx" "onnx/decoder_step_int8.onnx baberu-step.onnx"; do \
    set -- $f; curl -fL -o /models/$2 "https://huggingface.co/genshiai-daichi/baberu-ocr/resolve/main/$1?download=true"; \
  done \
  && curl -fL -o /models/vocab.json \
    "https://huggingface.co/genshiai-daichi/baberu-ocr/resolve/main/tokenizer/vocab.json?download=true" \
  && curl -fL -o /models/lama-manga-512-fp16w.onnx \
    "https://huggingface.co/c0ffeeOverdose/arn-manga-models/resolve/main/lama-manga-512-fp16w.onnx?download=true" \
  && ls -la /models
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}"]
