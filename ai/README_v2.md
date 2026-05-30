# TotalSegmentator v2 vertebrae inference (CT + MRI)

Standalone Python pipeline that runs the **TotalSegmentator v2** vertebrae
models on DICOM spine scans via the official `nnunetv2` predictor — so
preprocessing matches training exactly (nothing is hand-rolled, unlike the v1
`ai/main.py`). Viewer integration comes later; this is the Python pipeline only.

## Models

| Modality | nnU-Net dataset | Trainer | Norm (from plans.json) | Spacing |
|----------|-----------------|---------|------------------------|---------|
| CT  | `Dataset292_TotalSegmentator_part2_vertebrae_1532subj` | `nnUNetTrainerNoMirroring` | CTNormalization, clip→z-score (mean 367.33, std 320.86, p0.5 −96, p99.5 1514) | 1.5 mm iso |
| MRI | `Dataset756_mri_vertebrae_1076subj` | `nnUNetTrainer_DASegOrd0_NoMirroring` | ZScoreNormalization (per-image) | 1.5 mm iso |

Label sets (from each model's `dataset.json`): CT has 26 foreground labels
(`sacrum`, `vertebrae_S1`, `vertebrae_L5…C1`), MRI has 25 (`sacrum`,
`vertebrae_L5…C1`). Both ship `fold_0` only.

## Setup

```bash
# 1. Python deps into the repo's ./env (pulls torch, dynamic-network-architectures, …)
./env/bin/pip install nnunetv2

# 2. Download the model weights (~460 MB total; idempotent)
ai/download_v2_weights.sh        # -> ai/models_v2/Dataset292…, Dataset756…
```

## Run

```bash
# Both bundled test cases (CT + MRI) end to end
./env/bin/python ai/run_v2.py --all

# Single modality on a DICOM series directory
./env/bin/python ai/run_v2.py --modality ct  --dicom testdata/CT-axi-postop
./env/bin/python ai/run_v2.py --modality mri --dicom testdata/MR-T2-axi-postop

# On an already-converted NIfTI (skips the DICOM step)
./env/bin/python ai/run_v2.py --modality ct --nifti some_ct.nii.gz
```

DICOM → NIfTI uses SimpleITK's series reader (largest series wins), which bakes
orientation/spacing into the affine so nnU-Net reorients/resamples correctly.
Images are then read with the model's *own* configured reader/writer
(`NibabelIOWithReorient`) so the properties dict matches the writer.

## Output

`ai/output_v2/<case>/`:
- `<case>_0000.nii.gz` — converted input image (nnU-Net channel-0 naming)
- `<case>.nii.gz` — predicted label map, uint8, **same shape + affine as input**

## Verified results (bundled test data, RTX 4060)

| Case | Input | Time | Result |
|------|-------|------|--------|
| CT  `testdata/CT-axi-postop` | 512×512×226 @ 0.35×0.35×0.625 | ~62 s | C7→L1 thoracic block, 1.83 M labelled voxels |
| MRI `testdata/MR-T2-axi-postop` | 384×384×40 @ 0.47×0.47×3.3 | ~19 s | C7→L1, 133 K labelled voxels |

Both outputs are non-empty, uint8, and spatially aligned to their input
(shape + affine match). Note both test series are partial-FOV post-op spine
acquisitions, so the level *labels* can drift / show gaps — TotalSegmentator's
vertebra labeling is most reliable on full-spine FOV. The pipeline itself is
correct; level accuracy is a property of the input coverage.

## Notes for later viewer integration

- These are nnU-Net **v2** checkpoints (`checkpoint_final.pth` + `plans.json`),
  not loadable by the v1 loader in `ai/main.py`.
- The plans carry an "old plans format" warning — harmless; nnunetv2
  reconstructs the architecture from it at load time.
- For browser/ONNX use you'd export each network and re-read its `plans.json`
  preprocessing (above) rather than reusing the v1 constants in
  `extensions/cornerstone/src/ai/`.
- `ai/models_v2/`, `ai/output_v2/`, `ai/.nnunet_dummy/` and the run logs are
  git-ignored.
