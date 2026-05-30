#!/usr/bin/env python3
"""Export the TotalSegmentator **v2** vertebrae models (CT + MRI) to ONNX for
browser-side onnxruntime-web inference.

Unlike ai/export_onnx.py (which exports the v1 Generic_UNet via ai.main), this
script drives the same nnunetv2 predictor that ai/run_v2.py uses, so the exported
network is exactly the trained PlainConvUNet — no architecture is hand-built.

Usage:
    # export both models (default)
    python ai/export_onnx_v2.py

    # export a single modality
    python ai/export_onnx_v2.py --modality ct
    python ai/export_onnx_v2.py --modality mri

Outputs (so the OHIF dev server serves them under /ai-models/):
    platform/app/public/ai-models/vertebrae_ct.onnx
    platform/app/public/ai-models/vertebrae_mri.onnx

Requires: onnx, onnxruntime (CPU) for the sanity check. Skip with --skip-check.
"""

import argparse
import os
import sys

import numpy as np
import torch

_AI_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_AI_DIR)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Importing run_v2 runs its os.environ.setdefault for nnUNet_raw/preprocessed/
# results (run_v2.py) BEFORE nnunetv2 is imported elsewhere — required to avoid
# loud warnings/errors.
from ai.run_v2 import MODELS, find_model_folder  # noqa: E402

OUTPUT_DIR = os.path.join(_REPO_ROOT, "platform", "app", "public", "ai-models")
OUTPUT_NAMES = {"ct": "vertebrae_ct.onnx", "mri": "vertebrae_mri.onnx"}


def _build_cpu_predictor(model_folder):
    """Build an nnUNetPredictor pinned to CPU and load fold_0.

    initialize_from_trained_model_folder also loads the fold_0 weights into
    predictor.network, so no manual load_state_dict is needed.
    """
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    device = torch.device("cpu")
    predictor = nnUNetPredictor(
        tile_step_size=0.5,
        use_gaussian=True,
        use_mirroring=False,
        perform_everything_on_device=False,
        device=device,
        verbose=False,
        verbose_preprocessing=False,
        allow_tqdm=False,
    )
    predictor.initialize_from_trained_model_folder(
        model_folder,
        use_folds=("0",),
        checkpoint_name="checkpoint_final.pth",
    )
    return predictor


def export_modality(modality, opset, skip_check):
    cfg = MODELS[modality]
    model_folder = find_model_folder(cfg["dataset"])
    print(f"\n=== Exporting {modality.upper()} : {cfg['dataset']} ===")
    print(f"Model folder: {model_folder}")

    predictor = _build_cpu_predictor(model_folder)

    network = predictor.network
    # Defensive: unwrap torch.compile'd modules (not used here, but cheap to guard).
    if hasattr(network, "_orig_mod"):
        network = network._orig_mod
    network = network.to("cpu").eval()

    # Deep supervision is built off already; assert + force so forward() returns a
    # single tensor rather than a list of multi-resolution outputs.
    assert network.decoder.deep_supervision is False, "expected deep supervision off"
    network.decoder.deep_supervision = False

    num_classes = predictor.label_manager.num_segmentation_heads
    pd, ph, pw = predictor.configuration_manager.patch_size  # (D, H, W)
    print(f"Patch size (D,H,W): ({pd},{ph},{pw}), classes: {num_classes}")

    dummy = torch.zeros(1, 1, pd, ph, pw, dtype=torch.float32)

    with torch.no_grad():
        out = network(dummy)
    assert isinstance(out, torch.Tensor), f"expected a tensor, got {type(out)}"
    assert out.shape[1] == num_classes, f"output channels {out.shape[1]} != {num_classes}"

    out_path = os.path.join(OUTPUT_DIR, OUTPUT_NAMES[modality])
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Exporting to {out_path} (opset {opset})...")
    # Legacy TorchScript exporter (dynamo=False) so weights are embedded in the
    # .onnx rather than spilled to a .onnx.data sidecar — the browser fetches one
    # URL and ORT-Web does not chase external data.
    torch.onnx.export(
        network,
        dummy,
        out_path,
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
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"Wrote {out_path} ({size_mb:.1f} MB)")

    if skip_check:
        return

    try:
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime not installed — skipping sanity check.", file=sys.stderr)
        return

    print("Sanity check: PyTorch vs ONNXRuntime on a zero patch...")
    with torch.no_grad():
        torch_logits = network(dummy).cpu().numpy()
    torch_arg = np.argmax(torch_logits, axis=1)

    sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
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


def main():
    ap = argparse.ArgumentParser(description="Export v2 vertebrae models (CT + MRI) to ONNX")
    ap.add_argument(
        "--modality",
        choices=["ct", "mri"],
        help="export only this modality (default: export both)",
    )
    ap.add_argument("--opset", type=int, default=17, help="ONNX opset version (default: 17)")
    ap.add_argument(
        "--skip-check",
        action="store_true",
        help="skip the PyTorch vs ONNX argmax parity check",
    )
    args = ap.parse_args()

    targets = [args.modality] if args.modality else ["ct", "mri"]
    for modality in targets:
        export_modality(modality, args.opset, args.skip_check)


if __name__ == "__main__":
    main()
