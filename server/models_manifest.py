# Where the server gets its model weights. Imported by modal_app.py (image
# build) and scripts/make-colab.py (notebook generation); server/Dockerfile
# bakes the same URLs by hand (can't import across a Docker build stage).
CTD_URL = ("https://huggingface.co/lemondouble/lemon-manga-translator"
           "/resolve/main/onnx/comic-text-detector/ctd.onnx?download=true")
BABERU = "https://huggingface.co/genshiai-daichi/baberu-ocr/resolve/main"
BABERU_FILES = [
    ("onnx/vision_int4.onnx", "vision-int4.onnx"),
    ("onnx/decoder_prefill_int8.onnx", "baberu-prefill.onnx"),
    ("onnx/decoder_step_int8.onnx", "baberu-step.onnx"),
    ("tokenizer/vocab.json", "vocab.json"),
]

# Manga text-cleanup inpainting (manga-LaMa, fp16 weights, FFT-as-matmuls
# export). MIT model / Apache-2.0 arch — reproduce with
# scripts/export-inpaint-onnx.py. Same artifact the extension downloads.
INPAINT_URL = ("https://huggingface.co/c0ffeeOverdose/arn-manga-models"
               "/resolve/main/lama-manga-512-fp16w.onnx?download=true")
