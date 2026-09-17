"""Export the manga-tuned LaMa inpainting model to ONNX for ORT-web (WebGPU).

Source: dreMaz/AnimeMangaInpainting lama_large_512px.ckpt (MIT license) —
big-lama (FFCResNetGenerator, n_blocks=18, ngf=64, add_out_act=sigmoid)
fine-tuned on 300k manga/anime pages.

Why FFT-as-matmuls: ONNX Runtime Web's WebGPU EP has no DFT kernel, so any
export that keeps rfftn/irfftn stalls on CPU fallbacks (or fails). For a fixed
512x512 input every FourierUnit runs at the 64x64 bottleneck, so the spectral
branch is re-expressed as fixed real matmuls with orthonormal DFT matrices
built from torch.fft itself (conventions exact, verified below).

Why weight-only fp16: full int8 via DequantizeLinear is broken on ORT-web
WebGPU (NaN, reproduced on 1.26/1.29/1.30/latest-dev), and full-fp16 compute
needs shader-f16 which most Linux WebGPU stacks do not expose. fp16 weights +
Cast->fp32 before each Conv keeps all compute in fp32 (no f16 shader needed)
and lands within 1/255 of the fp32 export on real pages.

Usage:
  python3 scripts/export-inpaint-onnx.py --ckpt /path/to/lama_large_512px.ckpt \
      --out models/lama-manga-512-fp16w.onnx
Needs: torch (CPU wheel is fine; pip install torch --index-url
https://download.pytorch.org/whl/cpu), onnx, onnxruntime, numpy, pillow.

The exported model contract (fixed 512):
  input  [1, 4, 512, 512] float32 — channels 0-2 masked RGB in [0,1]
         (original * (1 - mask)), channel 3 binary mask in {0, 1}
  output [1, 3, 512, 512] float32 — RGB prediction in [0,1]; composite with
         the mask (pred * mask + original * (1 - mask)) on the caller side.
"""
import argparse
import hashlib
import pathlib
import sys
import types

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import TensorProto, helper, numpy_helper
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from lama_ffc import FourierUnit, load_generator


def build_matmul_fft(model: torch.nn.Module):
    """Replace every FourierUnit.forward with fixed-size matmul DFTs."""
    cache: dict[tuple[int, int], tuple] = {}

    def matrices(h: int, w: int):
        if (h, w) in cache:
            return cache[(h, w)]
        w2 = w // 2 + 1
        fh = torch.fft.fft(torch.eye(h), norm='ortho')            # [h,h] complex
        mw = torch.fft.fft(torch.eye(w), norm='ortho').T[:w, :w2]  # [w,w2]
        xr = torch.randn(1, 3, h, w)
        assert torch.allclose(torch.fft.rfftn(xr, dim=(-2, -1), norm='ortho'),
                              fh @ (xr[0].to(torch.complex64) @ mw), atol=1e-5)
        rr = torch.zeros(w, w2)
        ri = torch.zeros(w, w2)
        for k in range(w2):
            e = torch.zeros(w2, dtype=torch.complex64)
            e[k] = 1
            rr[:, k] = torch.fft.irfft(e, n=w, norm='ortho')
            e[k] = 1j
            ri[:, k] = torch.fft.irfft(e, n=w, norm='ortho')
        y = torch.randn(1, 2, h, w2, dtype=torch.complex64)
        assert torch.allclose(torch.fft.irfft(y, n=w, norm='ortho'),
                              y.real @ rr.t() + y.imag @ ri.t(), atol=1e-5)
        cache[(h, w)] = (fh.real.contiguous(), fh.imag.contiguous(),
                         mw.real.contiguous(), mw.imag.contiguous(),
                         fh.real.t().contiguous(), fh.imag.t().contiguous(),
                         rr.t().contiguous(), ri.t().contiguous())
        return cache[(h, w)]

    def mm_forward(self, x):
        a = torch.matmul(self._fhr, x)
        b = torch.matmul(self._fhi, x)
        fr = torch.matmul(a, self._mr) - torch.matmul(b, self._mi)
        fi = torch.matmul(a, self._mi) + torch.matmul(b, self._mr)
        s = torch.stack([fr, fi], dim=2).flatten(1, 2)  # (re, im) channel pairs — original layout
        z = self.relu(self.bn(self.conv_layer(s)))
        zr, zi = z[:, 0::2], z[:, 1::2]
        zr2 = torch.matmul(self._fhrT, zr) + torch.matmul(self._fhiT, zi)
        zi2 = torch.matmul(self._fhrT, zi) - torch.matmul(self._fhiT, zr)
        return torch.matmul(zr2, self._rrT) + torch.matmul(zi2, self._riT)

    patched = 0
    for m in model.modules():
        if isinstance(m, FourierUnit):
            names = ('_fhr', '_fhi', '_mr', '_mi', '_fhrT', '_fhiT', '_rrT', '_riT')
            for name, value in zip(names, matrices(64, 64)):
                m.register_buffer(name, value, persistent=False)
            m.forward = types.MethodType(mm_forward, m)
            patched += 1
    if patched != 36:
        raise SystemExit(f'expected 36 FourierUnits, patched {patched} — architecture changed?')
    return patched


def conv_weight_names(m: onnx.ModelProto):
    inits = {i.name: i for i in m.graph.initializer}
    return [n.input[1] for n in m.graph.node
            if n.op_type == 'Conv' and len(n.input) >= 2
            and n.input[1] in inits and inits[n.input[1]].data_type == TensorProto.FLOAT]


def to_fp16_weights(path: str) -> int:
    m = onnx.load(path)
    inits = {i.name: i for i in m.graph.initializer}
    names = conv_weight_names(m)
    new_inits, casts = [], []
    for name in names:
        w = numpy_helper.to_array(inits[name]).astype(np.float16)
        new_inits.append(numpy_helper.from_array(w, name + '_h'))
        casts.append(helper.make_node('Cast', [name + '_h'], [name + '_w'], to=TensorProto.FLOAT))
        for n in m.graph.node:
            for k, inp in enumerate(n.input):
                if inp == name:
                    n.input[k] = name + '_w'
    kept = [i for i in m.graph.initializer if i.name not in set(names)]
    del m.graph.initializer[:]
    m.graph.initializer.extend(kept + new_inits)
    nodes = list(m.graph.node)
    m.graph.ClearField('node')
    m.graph.node.extend(casts + nodes)
    onnx.save(onnx.shape_inference.infer_shapes(m), path)
    return len(names)


def test_input(size: int = 512):
    rng = np.random.default_rng(0)
    img = rng.random((size, size, 3), dtype=np.float32)
    mask = (rng.random((size, size)) > 0.6).astype(np.float32)
    x = np.concatenate([img * (1 - mask[..., None]), mask[..., None]], axis=2)
    return torch.from_numpy(np.transpose(x, (2, 0, 1)))[None]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--out', default='models/lama-manga-512-fp16w.onnx')
    ap.add_argument('--fp32-out', default='')
    args = ap.parse_args()

    print('loading generator…')
    model = load_generator(args.ckpt).eval()
    x = test_input()
    with torch.no_grad():
        ref = model(x)

    build_matmul_fft(model)
    with torch.no_grad():
        mm = model(x)
    diff = (mm - ref).abs().max().item()
    print(f'matmul-FFT vs torch.fft max abs diff: {diff:.3e}')
    assert diff < 1e-4, 'matmul FFT does not match'

    fp32_path = args.fp32_out or args.out.replace('.onnx', '-fp32.onnx')
    torch.onnx.export(model, (x,), fp32_path, input_names=['input'], output_names=['output'],
                      opset_version=17, do_constant_folding=True, dynamo=False)
    sess = ort.InferenceSession(fp32_path, providers=['CPUExecutionProvider'])
    out = sess.run(None, {'input': x.numpy()})[0]
    d = np.abs(out - ref.numpy()).max()
    print(f'fp32 ONNX vs PyTorch max abs diff: {d:.3e}')
    assert d < 1e-4

    import shutil
    shutil.copy(fp32_path, args.out)
    n = to_fp16_weights(args.out)
    out16 = ort.InferenceSession(args.out, providers=['CPUExecutionProvider']).run(None, {'input': x.numpy()})[0]
    d16 = np.abs(out16 - out).max()
    print(f'fp16w ONNX ({n} convs) vs fp32 ONNX: max {d16:.4f} ({d16 * 255:.0f}/255)')
    print(f'output {args.out}')
    print(f'  size   {__import__("os").path.getsize(args.out)} bytes')
    print(f'  sha256 {hashlib.sha256(open(args.out, "rb").read()).hexdigest()}')


if __name__ == '__main__':
    main()
