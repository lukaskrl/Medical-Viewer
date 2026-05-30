import type { ImageVolume } from '../../utils/extractDisplaySetVolume';
import {
  reorientToRAS,
  resampleTrilinear,
  clipAndZScore,
  zScorePerImage,
  type CanonicalVolume,
} from '../preprocessing';
import { reorientLabelmapToSource } from '../postprocessing';
import {
  estimateSlidingWindowMemory,
  runSlidingWindow,
  type SlidingWindowProgress,
} from '../slidingWindow';
import type { AIProgressEvent } from '../progress';

// Refuse to run if the estimated peak memory exceeds this. Browsers typically
// OOM tabs around 2 GB on 32-bit V8 and 4 GB on 64-bit; 1.5 GB is a safe cap
// that leaves headroom for everything else (ORT, viewer, etc.).
const MAX_ESTIMATED_BYTES = 1.5 * 1024 * 1024 * 1024;

// Both v2 models are resampled to 1.5 mm isotropic per their plans.json.
const TARGET_SPACING: [number, number, number] = [1.5, 1.5, 1.5];

/** nnU-Net v2 normalization scheme, per the model's plans.json. */
export type NormalizationConfig =
  | { kind: 'ct'; lo: number; hi: number; mean: number; std: number }
  | { kind: 'mri' };

export interface VertebraeModelConfig {
  /** Patch size in (z, y, x) — matches the model's plans.json patch_size. */
  patchSize: [number, number, number];
  /** Number of output classes incl. background. */
  numClasses: number;
  normalization: NormalizationConfig;
  labels: Record<number, string>;
}

// ---- CT: Dataset292_TotalSegmentator_part2_vertebrae_1532subj ------------------
// 27 classes (incl. background). CTNormalization: clip to [p0.5, p99.5] then
// z-score with the dataset's foreground mean/std (from plans.json).
const CT_LABELS: Record<number, string> = {
  1: 'Sacrum',
  2: 'S1',
  3: 'L5',
  4: 'L4',
  5: 'L3',
  6: 'L2',
  7: 'L1',
  8: 'T12',
  9: 'T11',
  10: 'T10',
  11: 'T9',
  12: 'T8',
  13: 'T7',
  14: 'T6',
  15: 'T5',
  16: 'T4',
  17: 'T3',
  18: 'T2',
  19: 'T1',
  20: 'C7',
  21: 'C6',
  22: 'C5',
  23: 'C4',
  24: 'C3',
  25: 'C2',
  26: 'C1',
};

export const CT_CONFIG: VertebraeModelConfig = {
  patchSize: [128, 128, 128],
  numClasses: 27,
  normalization: { kind: 'ct', lo: -96, hi: 1514, mean: 367.32929817099546, std: 320.8587389393513 },
  labels: CT_LABELS,
};

// ---- MRI: Dataset756_mri_vertebrae_1076subj ------------------------------------
// 26 classes (incl. background). ZScoreNormalization: per-image z-score.
const MRI_LABELS: Record<number, string> = {
  1: 'Sacrum',
  2: 'L5',
  3: 'L4',
  4: 'L3',
  5: 'L2',
  6: 'L1',
  7: 'T12',
  8: 'T11',
  9: 'T10',
  10: 'T9',
  11: 'T8',
  12: 'T7',
  13: 'T6',
  14: 'T5',
  15: 'T4',
  16: 'T3',
  17: 'T2',
  18: 'T1',
  19: 'C7',
  20: 'C6',
  21: 'C5',
  22: 'C4',
  23: 'C3',
  24: 'C2',
  25: 'C1',
};

export const MRI_CONFIG: VertebraeModelConfig = {
  patchSize: [112, 128, 160],
  numClasses: 26,
  normalization: { kind: 'mri' },
  labels: MRI_LABELS,
};

// --- Debug logging -------------------------------------------------------------
// Tagged, information-dense logging so a failing case can be diagnosed from the
// browser console without a debugger. Logs appear under the worker context.
const AI_LOG = '[AI/vertebrae]';

function f32stats(a: Float32Array): string {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let nan = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (Number.isNaN(v)) {
      nan++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = a.length ? sum / (a.length - nan) : 0;
  return `n=${a.length} min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${mean.toFixed(3)} NaN=${nan}`;
}

export interface VertebraeOptions {
  onnxUrl: string;
  onProgress?: (event: AIProgressEvent) => void;
}

export interface VertebraeResult {
  /** Labelmap in the OHIF source volume's (i, j, k) layout — slice-major, row-major. */
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
  labelNames: Record<number, string>;
}

export async function runVertebraeInference(
  volume: ImageVolume,
  opts: VertebraeOptions,
  config: VertebraeModelConfig
): Promise<VertebraeResult> {
  const { onnxUrl, onProgress } = opts;
  const PREPROCESS_STEPS = 3;

  console.log(
    `${AI_LOG} start: norm=${config.normalization.kind} patch=${config.patchSize.join('×')} ` +
      `classes=${config.numClasses} onnx=${onnxUrl}`
  );
  console.log(
    `${AI_LOG} input volume: shape(i,j,k)=${volume.width}×${volume.height}×${volume.depth} ` +
      `spacing=[${volume.spacing.map(s => s.toFixed(3)).join(', ')}] ` +
      `rowDir=[${volume.rowDirection.map(v => v.toFixed(2))}] ` +
      `colDir=[${volume.columnDirection.map(v => v.toFixed(2))}] ` +
      `sliceDir=[${volume.sliceDirection.map(v => v.toFixed(2))}]`
  );
  console.log(`${AI_LOG} input intensities: ${f32stats(volume.data as Float32Array)}`);

  onProgress?.({
    phase: 'preprocess',
    step: 0,
    total: PREPROCESS_STEPS,
    label: 'Reorienting volume to RAS',
  });
  const canonical: CanonicalVolume = reorientToRAS(volume);
  console.log(
    `${AI_LOG} canonical(z,y,x): shape=${canonical.shape.join('×')} ` +
      `spacing=[${canonical.spacing.map(s => s.toFixed(3)).join(', ')}] ` +
      `perm=[${canonical.permutation.join(',')}] flips=[${canonical.flips.join(',')}]`
  );
  console.log(`${AI_LOG} canonical intensities: ${f32stats(canonical.data)}`);

  onProgress?.({
    phase: 'preprocess',
    step: 1,
    total: PREPROCESS_STEPS,
    label: 'Resampling to 1.5mm isotropic',
  });
  const resampled = resampleTrilinear(
    canonical.data,
    canonical.shape,
    canonical.spacing,
    TARGET_SPACING
  );
  console.log(
    `${AI_LOG} resampled to ${TARGET_SPACING.join('mm,')}mm: shape=${resampled.shape.join('×')}`
  );
  console.log(`${AI_LOG} resampled intensities: ${f32stats(resampled.data)}`);

  onProgress?.({
    phase: 'preprocess',
    step: 2,
    total: PREPROCESS_STEPS,
    label: 'Normalizing intensities',
  });
  if (config.normalization.kind === 'ct') {
    const { lo, hi, mean, std } = config.normalization;
    console.log(`${AI_LOG} CTNormalization: clip[${lo}, ${hi}] zscore(mean=${mean}, std=${std})`);
    clipAndZScore(resampled.data, lo, hi, mean, std);
  } else {
    console.log(`${AI_LOG} ZScoreNormalization: per-image`);
    zScorePerImage(resampled.data);
  }
  console.log(`${AI_LOG} normalized intensities: ${f32stats(resampled.data)}`);

  const estBytes = estimateSlidingWindowMemory(
    resampled.shape,
    config.patchSize,
    config.numClasses
  );
  if (estBytes > MAX_ESTIMATED_BYTES) {
    const gb = (estBytes / 1024 / 1024 / 1024).toFixed(1);
    throw new Error(
      `Volume too large for in-browser inference (estimated peak ~${gb} GB after resampling ` +
        `to ${resampled.shape.join('×')}). Switch to "On AI server" or use a smaller field of view.`
    );
  }

  const labelmap = await runSlidingWindow(resampled.data, resampled.shape, {
    onnxUrl,
    patchSize: config.patchSize,
    numClasses: config.numClasses,
    stepSize: 0.5,
    onProgress: (p: SlidingWindowProgress) =>
      onProgress?.({ phase: 'inference', patch: p.patch, total: p.total }),
  });

  // Reserve the last postprocess step for the caller's "load into viewer"
  // pass, so we report this as step 0 of 2.
  onProgress?.({
    phase: 'postprocess',
    step: 0,
    total: 2,
    label: 'Resampling labelmap to source',
  });
  const back = reorientLabelmapToSource(labelmap, resampled.shape, canonical);

  onProgress?.({
    phase: 'postprocess',
    step: 1,
    total: 2,
    label: 'Finalizing',
  });

  // Final labelmap histogram so we can see whether (and which) labels survived.
  const hist = new Map<number, number>();
  for (let i = 0; i < back.data.length; i++) {
    const v = back.data[i];
    if (v !== 0) hist.set(v, (hist.get(v) ?? 0) + 1);
  }
  const fg = Array.from(hist.values()).reduce((a, b) => a + b, 0);
  const histStr = Array.from(hist.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([lbl, n]) => `${config.labels[lbl] ?? lbl}:${n}`)
    .join(' ');
  console.log(
    `${AI_LOG} result(i,j,k): shape=${back.width}×${back.height}×${back.depth} ` +
      `foreground=${fg} voxels, labels={${histStr}}`
  );
  if (fg === 0) {
    console.warn(`${AI_LOG} EMPTY segmentation — see stats above to locate where signal was lost.`);
  }

  return {
    data: back.data,
    width: back.width,
    height: back.height,
    depth: back.depth,
    labelNames: config.labels,
  };
}
