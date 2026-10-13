"""Export hash-pinned Koharu SafeTensors as fixed-1152 FP32 ONNX with bounded attention."""
import argparse
import hashlib
import importlib.metadata
from pathlib import Path
import shutil
import warnings

import onnx
import torch
from rfdetr import RFDETRSeg2XLarge
from rfdetr.config import PretrainWeightsCompatibilityWarning
from safetensors.torch import load_file

WEIGHTS_SHA = '9bf6d2cbd7793c956d8c857bb1672a396eb7f100eb0682f86830d05e31168efb'
ONNX_SHA = '35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', required=True, type=Path)
    parser.add_argument('--out', type=Path, default=Path('models/koharu-fp32-chunked.onnx'))
    args = parser.parse_args()
    if importlib.metadata.version('rfdetr') != '1.7.0':
        raise RuntimeError('This export requires rfdetr==1.7.0')
    if hashlib.sha256(args.weights.read_bytes()).hexdigest() != WEIGHTS_SHA:
        raise RuntimeError('Koharu SafeTensors checksum mismatch')
    torch.set_num_threads(4)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', PretrainWeightsCompatibilityWarning)
        model = RFDETRSeg2XLarge(pretrain_weights=None, resolution=1152, num_select=160, num_classes=4)
    model.model.model.load_state_dict(load_file(str(args.weights), device='cpu'), strict=True)
    model.model.class_names = ['text', 'onomatopoeia', 'bubble', 'panel']
    model.model.model.eval()
    original = torch.nn.functional.scaled_dot_product_attention
    chunk_size = 256

    def bounded_attention(query, key, value, attn_mask=None, dropout_p=0.0,
                          is_causal=False, scale=None, enable_gqa=False):
        if is_causal or dropout_p != 0 or attn_mask is not None or enable_gqa:
            raise RuntimeError('Only noncausal unmasked inference attention is supported')
        return torch.cat([original(query[..., i:i + chunk_size, :], key, value,
                                   dropout_p=0.0, is_causal=False, scale=scale)
                          for i in range(0, int(query.shape[-2]), chunk_size)], dim=-2)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.nn.functional.scaled_dot_product_attention = bounded_attention
    try:
        exported = model.export(output_dir=str(args.out.parent / 'koharu-export'),
                                shape=(1152, 1152), opset_version=17, batch_size=1, verbose=False)
    finally:
        torch.nn.functional.scaled_dot_product_attention = original
    onnx.checker.check_model(str(exported))
    digest = hashlib.sha256(Path(exported).read_bytes()).hexdigest()
    if digest != ONNX_SHA:
        raise RuntimeError(f'Export differs from the supported artifact: {digest}. Check the pinned export environment.')
    shutil.copyfile(exported, args.out)
    print(f'{args.out}: {args.out.stat().st_size} bytes, sha256 {digest}')


if __name__ == '__main__':
    main()
