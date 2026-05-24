#!/usr/bin/env python3
"""Export the nnU-Net vertebrae model to ONNX for browser-side inference.

Usage:
    python ai/export_onnx.py [--output PATH] [--opset 17]

The output defaults to `platform/app/public/ai-models/vertebrae.onnx`
so the OHIF dev server serves it at `/ai-models/vertebrae.onnx`.

After export, the script optionally runs a sanity check that loads the
ONNX file with onnxruntime (CPU) and compares argmax outputs against the
PyTorch model on a single zero patch. Skip with --skip-check.

Requires: onnx, onnxruntime (CPU). Install via `pip install onnx onnxruntime`.
"""

import argparse
import os
import sys

import numpy as np
import torch

# Make `ai.main` importable when this script is run directly.
_AI_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_AI_DIR)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from ai.main import PATCH_SIZE, load_model  # noqa: E402


DEFAULT_OUTPUT = os.path.join(
    _REPO_ROOT, "platform", "app", "public", "ai-models", "vertebrae.onnx"
)


def export(output_path: str, opset: int, skip_check: bool) -> None:
    device = torch.device("cpu")
    print(f"Loading PyTorch model on {device}...")
    model, num_classes = load_model(device)
    model.eval()
    # nnUNet's Generic_UNet supports a deep-supervision flag — ensure it's off
    # so the network has exactly one output tensor.
    if hasattr(model, "do_ds"):
        model.do_ds = False
    print(f"Model loaded ({num_classes} output classes)")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # PATCH_SIZE in ai/main.py is (z, y, x). For ONNX export we pass a 5-D tensor
    # (N, C, D, H, W). Dynamic batch + spatial axes let the model run on padded
    # inference patches that don't exactly match the training patch size.
    pd, ph, pw = PATCH_SIZE
    dummy = torch.zeros(1, 1, pd, ph, pw, dtype=torch.float32)

    print(f"Exporting to {output_path} (opset {opset})...")
    # Use the legacy TorchScript exporter (dynamo=False) so weights are embedded
    # in the .onnx file rather than spilled into a separate .onnx.data sidecar.
    # The browser fetches a single URL and ORT-Web does not chase external data.
    torch.onnx.export(
        model,
        dummy,
        output_path,
        input_names=["input"],
        output_names=["logits"],
        opset_version=opset,
        dynamic_axes={
            "input": {0: "batch", 2: "D", 3: "H", 4: "W"},
            "logits": {0: "batch", 2: "D", 3: "H", 4: "W"},
        },
        do_constant_folding=True,
        dynamo=False,
    )
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Wrote {output_path} ({size_mb:.1f} MB)")

    if skip_check:
        return

    try:
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime not installed — skipping sanity check.", file=sys.stderr)
        return

    print("Sanity check: PyTorch vs ONNXRuntime on a zero patch...")
    with torch.no_grad():
        torch_logits = model(dummy).cpu().numpy()
    torch_arg = np.argmax(torch_logits, axis=1)

    sess = ort.InferenceSession(output_path, providers=["CPUExecutionProvider"])
    ort_logits = sess.run(["logits"], {"input": dummy.numpy()})[0]
    ort_arg = np.argmax(ort_logits, axis=1)

    diff = int((torch_arg != ort_arg).sum())
    total = int(torch_arg.size)
    print(f"  argmax mismatch: {diff} / {total} voxels")
    if diff > 0:
        print(
            "WARNING: ONNX export does not match PyTorch exactly. "
            "Inference may produce different results in the browser.",
            file=sys.stderr,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        "-o",
        default=DEFAULT_OUTPUT,
        help=f"Output .onnx path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--opset", type=int, default=17, help="ONNX opset version (default: 17)"
    )
    parser.add_argument(
        "--skip-check",
        action="store_true",
        help="Skip the PyTorch vs ONNX argmax parity check",
    )
    args = parser.parse_args()
    export(args.output, args.opset, args.skip_check)


if __name__ == "__main__":
    main()
