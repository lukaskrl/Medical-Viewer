#!/usr/bin/env python3
"""
TotalSegmentator inference using a locally downloaded nnUNet v1 checkpoint.

Usage:
    python main.py <input.nii.gz> [--output output_seg.nii.gz]

Preprocessing (from plans.pkl):
  - Reorient to RAS+, transpose to (z, y, x) array order
  - Resample to 1.5mm isotropic spacing
  - CT normalization: clip to [-64, 1352], z-score with mean=334.86, std=259.03
  - Sliding-window inference with 160x112x112 patches, step 0.5

Output: NIfTI segmentation mask in the same space as the input.
"""

import argparse
import os
import pickle
import sys
import time

import numpy as np
import nibabel as nib
import torch
import torch.nn as nn
from scipy.ndimage import gaussian_filter
from skimage.transform import resize

AI_DIR = os.path.dirname(os.path.abspath(__file__))
CHECKPOINT_DIR = os.path.join(AI_DIR, "nnUNetTrainerV2_ep4000_nomirror__nnUNetPlansv2.1")

# Task252_TotalSegmentator_part2_vertebrae — 24 vertebrae classes (L5→C1)
LABEL_NAMES = {
    0:  "background",
    1:  "vertebrae_L5", 2:  "vertebrae_L4", 3:  "vertebrae_L3",
    4:  "vertebrae_L2", 5:  "vertebrae_L1",
    6:  "vertebrae_T12", 7:  "vertebrae_T11", 8:  "vertebrae_T10",
    9:  "vertebrae_T9",  10: "vertebrae_T8",  11: "vertebrae_T7",
    12: "vertebrae_T6",  13: "vertebrae_T5",  14: "vertebrae_T4",
    15: "vertebrae_T3",  16: "vertebrae_T2",  17: "vertebrae_T1",
    18: "vertebrae_C7",  19: "vertebrae_C6",  20: "vertebrae_C5",
    21: "vertebrae_C4",  22: "vertebrae_C3",  23: "vertebrae_C2",
    24: "vertebrae_C1",
}

# From plans.pkl intensityproperties: clip to [percentile_00_5, percentile_99_5],
# then z-score with the dataset mean/std computed after clipping.
CT_CLIP_MIN = -64.0
CT_CLIP_MAX = 1352.0
CT_MEAN = 334.86
CT_STD = 259.03

TARGET_SPACING = np.array([1.5, 1.5, 1.5])
PATCH_SIZE = (160, 112, 112)  # from plans.pkl patch_size


# ---- Preprocessing -------------------------------------------------------------

def resample_volume(volume, original_spacing, target_spacing):
    """Resample a 3D float volume using skimage.resize (matches nnUNet v1)."""
    original_spacing = np.array(original_spacing, dtype=np.float64)
    target_spacing = np.array(target_spacing, dtype=np.float64)
    new_shape = np.round(np.array(volume.shape) * original_spacing / target_spacing).astype(int)
    if np.all(new_shape == np.array(volume.shape)):
        return volume.astype(np.float32)
    return resize(volume.astype(np.float32), new_shape, order=3,
                  mode='edge', anti_aliasing=False, preserve_range=True).astype(np.float32)


def normalize_ct(volume):
    # nnUNet v1 CT scheme: clip to global percentiles, then z-score with
    # GLOBAL (dataset) mean/std from plans.pkl intensityproperties.
    volume = np.clip(volume, CT_CLIP_MIN, CT_CLIP_MAX)
    return ((volume - CT_MEAN) / CT_STD).astype(np.float32)


def resample_seg_back(seg, target_shape):
    """Resample integer segmentation back to original shape (one-hot then trilinear).

    Using one-hot avoids label-mixing artifacts that nearest-neighbour produces
    near class boundaries. This matches what nnUNet does on the segmentation side.
    """
    seg = np.asarray(seg)
    target_shape = tuple(int(x) for x in target_shape)
    if seg.shape == target_shape:
        return seg.astype(np.uint8)
    unique_labels = np.unique(seg)
    out_label = np.zeros(target_shape, dtype=np.uint8)
    best = np.zeros(target_shape, dtype=np.float32)
    for lbl in unique_labels:
        mask = (seg == lbl).astype(np.float32)
        resized = resize(mask, target_shape, order=1, mode='edge',
                         anti_aliasing=False, preserve_range=True)
        mask_better = resized > best
        out_label[mask_better] = lbl
        best[mask_better] = resized[mask_better]
    return out_label


# ---- Model loading -------------------------------------------------------------

def load_model(device):
    from nnunet.network_architecture.generic_UNet import Generic_UNet
    from nnunet.network_architecture.initialization import InitWeights_He

    with open(os.path.join(CHECKPOINT_DIR, "plans.pkl"), "rb") as f:
        plans = pickle.load(f)

    stage = plans['plans_per_stage'][0]
    pool_op_kernel_sizes = [list(k) for k in stage['pool_op_kernel_sizes']]
    conv_kernel_sizes = [list(k) for k in stage['conv_kernel_sizes']]
    num_pool = len(pool_op_kernel_sizes)
    base_num_features = int(plans['base_num_features'])
    conv_per_stage = int(plans['conv_per_stage'])
    num_classes = int(plans['num_classes']) + 1  # +1 for background

    model = Generic_UNet(
        input_channels=1,
        base_num_features=base_num_features,
        num_classes=num_classes,
        num_pool=num_pool,
        num_conv_per_stage=conv_per_stage,
        feat_map_mul_on_downscale=2,
        conv_op=nn.Conv3d,
        norm_op=nn.InstanceNorm3d,
        norm_op_kwargs={'eps': 1e-5, 'affine': True},
        dropout_op=nn.Dropout3d,
        dropout_op_kwargs={'p': 0, 'inplace': True},
        nonlin=nn.LeakyReLU,
        nonlin_kwargs={'negative_slope': 1e-2, 'inplace': True},
        deep_supervision=False,
        dropout_in_localization=False,
        final_nonlin=lambda x: x,
        weightInitializer=InitWeights_He(1e-2),
        pool_op_kernel_sizes=pool_op_kernel_sizes,
        conv_kernel_sizes=conv_kernel_sizes,
        upscale_logits=False,
        convolutional_pooling=True,
        convolutional_upsampling=True,
    )

    checkpoint_path = os.path.join(CHECKPOINT_DIR, "fold_0", "model_final_checkpoint.model")
    checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)
    model.load_state_dict(checkpoint['state_dict'])
    model.to(device)
    return model, num_classes


# ---- Sliding-window inference --------------------------------------------------

def _gaussian_kernel(patch_size, sigma_scale=1.0 / 8):
    tmp = np.zeros(patch_size)
    center = tuple(s // 2 for s in patch_size)
    sigmas = [s * sigma_scale for s in patch_size]
    tmp[center] = 1
    kernel = gaussian_filter(tmp, sigmas, 0, mode='constant', cval=0)
    kernel[kernel == 0] = kernel[kernel != 0].min()
    return (kernel / kernel.max()).astype(np.float32)


def sliding_window_inference(volume_np, model, num_classes, device, step_size=0.5):
    D, H, W = volume_np.shape
    pd, ph, pw = PATCH_SIZE

    pad_d = max(0, pd - D)
    pad_h = max(0, ph - H)
    pad_w = max(0, pw - W)
    pad_value = float(volume_np.min())  # pad with normalized minimum (air)
    volume_pad = np.pad(volume_np,
                        ((pad_d // 2, pad_d - pad_d // 2),
                         (pad_h // 2, pad_h - pad_h // 2),
                         (pad_w // 2, pad_w - pad_w // 2)),
                        mode='constant', constant_values=pad_value)
    D_p, H_p, W_p = volume_pad.shape

    step_d = max(1, int(pd * step_size))
    step_h = max(1, int(ph * step_size))
    step_w = max(1, int(pw * step_size))

    def patch_starts(size, patch, step):
        starts = list(range(0, size - patch + 1, step))
        if not starts or starts[-1] + patch < size:
            starts.append(size - patch)
        return starts

    starts_d = patch_starts(D_p, pd, step_d)
    starts_h = patch_starts(H_p, ph, step_h)
    starts_w = patch_starts(W_p, pw, step_w)

    aggregated = np.zeros((num_classes, D_p, H_p, W_p), dtype=np.float32)
    weight_sum = np.zeros((D_p, H_p, W_p), dtype=np.float32)
    gauss = _gaussian_kernel(PATCH_SIZE)

    total = len(starts_d) * len(starts_h) * len(starts_w)
    count = 0
    print(f"  {total} patches ({len(starts_d)}x{len(starts_h)}x{len(starts_w)})...")

    model.eval()
    with torch.no_grad():
        for sd in starts_d:
            for sh in starts_h:
                for sw in starts_w:
                    patch = volume_pad[sd:sd + pd, sh:sh + ph, sw:sw + pw]
                    t = torch.from_numpy(patch[None, None]).to(device)
                    logits = model(t)
                    probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
                    aggregated[:, sd:sd + pd, sh:sh + ph, sw:sw + pw] += probs * gauss
                    weight_sum[sd:sd + pd, sh:sh + ph, sw:sw + pw] += gauss
                    count += 1
                    if count % max(1, total // 20) == 0:
                        print(f"  {count}/{total} ({100*count//total}%)", end="\r", flush=True)

    aggregated /= weight_sum[None]
    aggregated = aggregated[:,
                 pad_d // 2: pad_d // 2 + D,
                 pad_h // 2: pad_h // 2 + H,
                 pad_w // 2: pad_w // 2 + W]
    return np.argmax(aggregated, axis=0).astype(np.uint8)


# ---- Main ----------------------------------------------------------------------

def run_inference(input_path, output_path):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    print(f"Loading {input_path}...")
    img_orig = nib.load(input_path)
    orig_affine = img_orig.affine
    orig_axcodes = nib.aff2axcodes(orig_affine)
    print(f"Original shape: {img_orig.shape}, orientation: {orig_axcodes}")

    # Reorient to canonical RAS+ — TotalSegmentator's training pipeline
    # standardises orientation this way, and the trainer is "nomirror" so
    # we cannot rely on the network being flip-equivariant.
    img_ras = nib.as_closest_canonical(img_orig)
    volume_ras = img_ras.get_fdata(dtype=np.float32)
    ras_zooms = np.abs(np.array(img_ras.header.get_zooms()[:3], dtype=np.float64))
    ras_affine = img_ras.affine
    print(f"RAS shape: {volume_ras.shape}, spacing: {ras_zooms} mm")

    # nnUNet v1 (via SimpleITK) operates on arrays in (z, y, x) order so that
    # patch_size[0]=160 lines up with the slice (S/I) axis. With nibabel RAS+
    # data, the array is (R, A, S) — transpose (2,1,0) to get (S, A, R).
    volume_sitk = volume_ras.transpose(2, 1, 0)
    spacing_sitk = ras_zooms[[2, 1, 0]]  # (z, y, x) spacing
    print(f"sitk-order shape: {volume_sitk.shape}, spacing: {spacing_sitk} mm")

    print(f"Resampling to {TARGET_SPACING} mm (z,y,x)...")
    volume_resampled = resample_volume(volume_sitk, spacing_sitk, TARGET_SPACING)
    print(f"Resampled shape: {volume_resampled.shape}")

    print("Normalizing CT intensities (clip + dataset z-score)...")
    volume_norm = normalize_ct(volume_resampled)
    print(f"  normalized stats — min:{volume_norm.min():.3f} max:{volume_norm.max():.3f} "
          f"mean:{volume_norm.mean():.3f} std:{volume_norm.std():.3f}")

    # Save preprocessed image (resampled + normalized) for visual inspection.
    # Build an affine that matches its (z, y, x) array order so a viewer shows
    # it in the right anatomical orientation.
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    preproc_path = output_path.replace("_seg.nii.gz", "_preprocessed.nii.gz")
    if preproc_path == output_path:
        preproc_path = output_path.replace(".nii.gz", "_preprocessed.nii.gz")
    # Transpose back to (R, A, S) so the saved file is viewable as a normal CT
    preproc_for_save = volume_norm.transpose(2, 1, 0)
    preproc_affine = np.diag([TARGET_SPACING[2], TARGET_SPACING[1], TARGET_SPACING[0], 1.0])
    preproc_affine[:3, 3] = ras_affine[:3, 3]
    nib.save(nib.Nifti1Image(preproc_for_save.astype(np.float32), preproc_affine), preproc_path)
    print(f"Saved preprocessed image to: {preproc_path}")

    print("Loading model...")
    model, num_classes = load_model(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"Model loaded ({n_params:,} parameters)")

    print("Running sliding-window inference...")
    t0 = time.time()
    seg_resampled = sliding_window_inference(volume_norm, model, num_classes, device)
    print(f"\nInference done in {time.time() - t0:.1f}s")
    print(f"Inference seg shape: {seg_resampled.shape}, "
          f"unique labels: {np.unique(seg_resampled).tolist()}")

    print("Resampling segmentation back to RAS shape...")
    seg_back_sitk = resample_seg_back(seg_resampled, volume_sitk.shape)

    # Transpose back from (S, A, R) → (R, A, S) to undo the earlier transpose
    seg_ras = seg_back_sitk.transpose(2, 1, 0)
    print(f"RAS seg shape: {seg_ras.shape}")

    # Wrap as a Nifti in RAS, then reorient back to the original orientation
    seg_ras_img = nib.Nifti1Image(seg_ras.astype(np.uint8), ras_affine)
    seg_ras_img.set_data_dtype(np.uint8)
    # Build orientation transform RAS -> original
    ras_ornt = nib.orientations.axcodes2ornt(('R', 'A', 'S'))
    orig_ornt = nib.orientations.axcodes2ornt(orig_axcodes)
    transform = nib.orientations.ornt_transform(ras_ornt, orig_ornt)
    seg_orig_arr = nib.orientations.apply_orientation(seg_ras, transform).astype(np.uint8)
    print(f"Final segmentation shape: {seg_orig_arr.shape} (input was {img_orig.shape})")

    unique_labels = np.unique(seg_orig_arr)
    foreground = [l for l in unique_labels if l > 0]
    print(f"\nDetected {len(foreground)} structures:")
    for lbl in foreground:
        name = LABEL_NAMES.get(int(lbl), f"class_{lbl}")
        count = int((seg_orig_arr == lbl).sum())
        print(f"  {lbl:3d}: {name:20s}  ({count:>8d} voxels)")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    out_img = nib.Nifti1Image(seg_orig_arr, orig_affine, img_orig.header)
    out_img.set_data_dtype(np.uint8)
    nib.save(out_img, output_path)
    print(f"\nSaved segmentation to: {output_path}")
    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="TotalSegmentator inference with local nnUNet v1 checkpoint"
    )
    parser.add_argument("input", help="Input NIfTI file (.nii or .nii.gz)")
    parser.add_argument(
        "--output", "-o",
        help="Output NIfTI file (default: ai/output/<name>_seg.nii.gz)"
    )
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    if args.output:
        output_path = args.output
    else:
        basename = os.path.basename(args.input)
        for ext in (".nii.gz", ".nii"):
            if basename.endswith(ext):
                basename = basename[: -len(ext)]
                break
        output_path = os.path.join(AI_DIR, "output", f"{basename}_seg.nii.gz")

    run_inference(args.input, output_path)


if __name__ == "__main__":
    main()
