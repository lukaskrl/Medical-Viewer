#!/usr/bin/env python3
"""
TotalSegmentator **v2** vertebrae inference (CT + MRI) using the official
nnU-Net v2 predictor.

Unlike ai/main.py (which hand-rolls nnU-Net **v1** preprocessing for the v1
Task252 CT model), this script delegates all preprocessing — reorientation,
resampling, normalization, sliding window, Gaussian aggregation and
postprocessing — to nnunetv2's `nnUNetPredictor`. The predictor reads each
model's bundled `plans.json` / `dataset.json`, so preprocessing is by
construction identical to how the model was trained. No constants are hard
coded here.

Models (fetched into ai/models_v2/ by download_v2_weights.sh):
  - CT  : Dataset292_TotalSegmentator_part2_vertebrae_1532subj   (channel CT)
  - MRI : Dataset756_mri_vertebrae_1076subj                      (channel MR)

Usage:
    # run both bundled test cases (CT + MRI) end to end
    python ai/run_v2.py --all

    # single modality on a DICOM series directory
    python ai/run_v2.py --modality ct  --dicom testdata/CT-axi-postop
    python ai/run_v2.py --modality mri --dicom testdata/MR-T2-axi-postop

    # on an already-converted NIfTI (skips the DICOM step)
    python ai/run_v2.py --modality ct --nifti some_ct.nii.gz

Outputs go to ai/output_v2/<case>/:
    <case>_0000.nii.gz   converted input image (nnU-Net channel-0 naming)
    <case>.nii.gz        predicted label map (same shape + affine as the input)
"""

import argparse
import os
import shutil
import time

import numpy as np

AI_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(AI_DIR, "models_v2")
OUTPUT_DIR = os.path.join(AI_DIR, "output_v2")

# nnU-Net v2 prints loud warnings if these aren't set. We never train or
# preprocess for training here, so dummy dirs are fine. Must be set before the
# first nnunetv2 import.
os.environ.setdefault("nnUNet_raw", os.path.join(AI_DIR, ".nnunet_dummy", "raw"))
os.environ.setdefault("nnUNet_preprocessed", os.path.join(AI_DIR, ".nnunet_dummy", "pre"))
os.environ.setdefault("nnUNet_results", os.path.join(AI_DIR, ".nnunet_dummy", "res"))

MODELS = {
    "ct": {
        "dataset": "Dataset292_TotalSegmentator_part2_vertebrae_1532subj",
        "default_dicom": os.path.join("testdata", "CT-axi-postop"),
        "case": "ct_spine",
    },
    "mri": {
        "dataset": "Dataset756_mri_vertebrae_1076subj",
        "default_dicom": os.path.join("testdata", "MR-T2-axi-postop"),
        "case": "mri_spine",
    },
}


def find_model_folder(dataset_name):
    """Locate the single `<trainer>__<plans>__3d_fullres` folder in a dataset dir.

    The trainer prefix differs per model (CT: nnUNetTrainerNoMirroring,
    MRI: nnUNetTrainer_DASegOrd0_NoMirroring), so we glob for it rather than
    hard coding.
    """
    ds_dir = os.path.join(MODELS_DIR, dataset_name)
    if not os.path.isdir(ds_dir):
        raise FileNotFoundError(
            f"Dataset not found: {ds_dir}\nRun ai/download_v2_weights.sh first."
        )
    candidates = [
        os.path.join(ds_dir, name)
        for name in sorted(os.listdir(ds_dir))
        if name.endswith("__3d_fullres")
        and os.path.isfile(os.path.join(ds_dir, name, "plans.json"))
    ]
    if not candidates:
        raise FileNotFoundError(f"No 3d_fullres model folder under {ds_dir}")
    if len(candidates) > 1:
        print(f"  multiple model folders under {ds_dir}; using {candidates[0]}")
    return candidates[0]


# ---- DICOM -> NIfTI ------------------------------------------------------------

def dicom_series_to_nifti(dicom_dir, out_path):
    """Read a DICOM series directory and write a NIfTI volume.

    SimpleITK's series reader sorts slices by ImagePositionPatient and bakes the
    correct orientation/spacing into the output affine — the spatial metadata
    nnU-Net needs to reorient and resample. If several series are present we use
    the one with the most slices (the main acquisition).
    """
    import SimpleITK as sitk

    reader = sitk.ImageSeriesReader()
    series_ids = reader.GetGDCMSeriesIDs(dicom_dir)
    if not series_ids:
        raise RuntimeError(f"No DICOM series found in {dicom_dir}")

    best_series, best_files = None, []
    for sid in series_ids:
        files = reader.GetGDCMSeriesFileNames(dicom_dir, sid)
        if len(files) > len(best_files):
            best_series, best_files = sid, files
    if len(series_ids) > 1:
        print(f"  {len(series_ids)} series present; using largest "
              f"({len(best_files)} slices)")

    reader.SetFileNames(best_files)
    image = reader.Execute()
    print(f"  series -> size {image.GetSize()}, spacing "
          f"{tuple(round(s, 3) for s in image.GetSpacing())} mm")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sitk.WriteImage(image, out_path)
    return out_path


# ---- nnU-Net v2 inference ------------------------------------------------------

def get_predictor(model_folder):
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    predictor = nnUNetPredictor(
        tile_step_size=0.5,
        use_gaussian=True,
        use_mirroring=False,          # these are the *NoMirroring trainers
        perform_everything_on_device=(device.type == "cuda"),
        device=device,
        verbose=False,
        verbose_preprocessing=False,
        allow_tqdm=True,
    )
    predictor.initialize_from_trained_model_folder(
        model_folder,
        use_folds=("0",),
        checkpoint_name="checkpoint_final.pth",
    )
    return predictor, device


def infer_nifti(modality, input_path, output_path):
    """Run a v2 model on an input NIfTI and write the label NIfTI to output_path.

    Modality-agnostic core shared by the CLI (run_modality) and the AI server
    (ai/server/models_registry.py). All preprocessing/postprocessing is handled
    internally by the predictor per the model's own plans.json.
    """
    cfg = MODELS[modality]
    model_folder = find_model_folder(cfg["dataset"])

    predictor, device = get_predictor(model_folder)
    print(f"Device: {device}")

    # In-process single-image API. This bypasses nnU-Net's multiprocessing data
    # iterator (which only helps for batch folders and otherwise hides errors as
    # "background workers no longer alive") while applying the identical
    # preprocessing / sliding-window / postprocessing internally.
    #
    # Read with the *predictor's own* configured reader/writer class so the
    # returned properties dict matches what the export/writer step expects
    # (mixing e.g. SimpleITKIO read + NibabelIO write -> KeyError 'nibabel_stuff').
    rw = predictor.plans_manager.image_reader_writer_class()
    data, props = rw.read_images([input_path])

    # predict_single_npy_array writes <truncated><file_ending>; strip the .nii.gz
    # so the final path is exactly output_path.
    truncated = output_path
    for ext in (".nii.gz", ".nii"):
        if truncated.endswith(ext):
            truncated = truncated[: -len(ext)]
            break

    t0 = time.time()
    predictor.predict_single_npy_array(
        data,
        props,
        output_file_truncated=truncated,
        save_or_return_probabilities=False,
    )
    dt = time.time() - t0

    produced = truncated + ".nii.gz"
    if produced != output_path and os.path.isfile(produced):
        shutil.move(produced, output_path)
    if not os.path.isfile(output_path):
        raise RuntimeError(f"Expected output not produced: {output_path}")
    print(f"Inference done in {dt:.1f}s -> {output_path}")
    return output_path


def run_modality(modality, dicom_dir=None, nifti_path=None):
    cfg = MODELS[modality]
    model_folder = find_model_folder(cfg["dataset"])

    case = cfg["case"]
    case_out = os.path.join(OUTPUT_DIR, case)
    os.makedirs(case_out, exist_ok=True)

    # nnU-Net expects channel-0 inputs named <case>_0000<file_ending>.
    input_nifti = os.path.join(case_out, f"{case}_0000.nii.gz")

    print(f"\n=== {modality.upper()} : {cfg['dataset']} ===")
    if nifti_path:
        print(f"Using provided NIfTI: {nifti_path}")
        shutil.copyfile(nifti_path, input_nifti)
    else:
        print(f"Converting DICOM series: {dicom_dir}")
        dicom_series_to_nifti(dicom_dir, input_nifti)

    output_seg = os.path.join(case_out, f"{case}.nii.gz")
    infer_nifti(modality, input_nifti, output_seg)

    summarize(output_seg, model_folder)
    return output_seg


# ---- Reporting -----------------------------------------------------------------

def summarize(seg_path, model_folder):
    import json
    import nibabel as nib

    labels = json.load(open(os.path.join(model_folder, "dataset.json")))["labels"]
    id_to_name = {v: k for k, v in labels.items()}

    seg = np.asanyarray(nib.load(seg_path).dataobj)
    present = [int(v) for v in np.unique(seg) if v != 0]
    print(f"Detected {len(present)} structures:")
    for lbl in present:
        count = int((seg == lbl).sum())
        print(f"  {lbl:3d}: {id_to_name.get(lbl, '?'):16s} ({count:>8d} voxels)")
    if not present:
        print("  WARNING: segmentation is empty — check input orientation/modality.")


# ---- CLI -----------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="TotalSegmentator v2 vertebrae inference (CT + MRI)")
    ap.add_argument("--modality", choices=["ct", "mri"], help="which model to run")
    ap.add_argument("--dicom", help="DICOM series directory (defaults to bundled test case)")
    ap.add_argument("--nifti", help="input NIfTI instead of DICOM (skips conversion)")
    ap.add_argument("--all", action="store_true", help="run both bundled CT + MRI test cases")
    args = ap.parse_args()

    if args.all:
        for modality in ("ct", "mri"):
            dicom = os.path.join(_repo_root(), MODELS[modality]["default_dicom"])
            run_modality(modality, dicom_dir=dicom)
        return

    if not args.modality:
        ap.error("specify --modality ct|mri, or --all")

    if args.nifti:
        run_modality(args.modality, nifti_path=args.nifti)
    else:
        dicom = args.dicom or os.path.join(_repo_root(), MODELS[args.modality]["default_dicom"])
        run_modality(args.modality, dicom_dir=dicom)


def _repo_root():
    return os.path.dirname(AI_DIR)


if __name__ == "__main__":
    main()
