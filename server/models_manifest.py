# Model weight URLs. Imported by modal_app.py and make-colab.py; Dockerfile bakes the same URLs by hand.
CTD_URL = ("https://huggingface.co/lemondouble/lemon-manga-translator"
           "/resolve/main/onnx/comic-text-detector/ctd.onnx?download=true")
KOHARU_FILE = "koharu-fp32-chunked.onnx"
KOHARU_BYTES = 149799163
KOHARU_SHA256 = "35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6"
KOHARU_RECIPE = "koharu-fp32-q256-v3"
KOHARU_URL = ("https://huggingface.co/c0ffeeOverdose/arn-manga-models"
              f"/resolve/main/{KOHARU_FILE}?download=true")
BABERU = "https://huggingface.co/genshiai-daichi/baberu-ocr/resolve/main"
BABERU_FILES = [
    ("onnx/vision_int4.onnx", "vision-int4.onnx"),
    ("onnx/decoder_prefill_int8.onnx", "baberu-prefill.onnx"),
    ("onnx/decoder_step_int8.onnx", "baberu-step.onnx"),
    ("tokenizer/vocab.json", "vocab.json"),
]

# Text-cleanup inpainting (manga-LaMa fp16 weights). MIT model / Apache-2.0 arch; same artifact the extension downloads.
INPAINT_URL = ("https://huggingface.co/c0ffeeOverdose/arn-manga-models"
               "/resolve/main/lama-manga-512-fp16w.onnx?download=true")
