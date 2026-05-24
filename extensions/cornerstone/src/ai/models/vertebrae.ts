import type { ImageVolume } from '../../utils/extractDisplaySetVolume';
import {
  reorientToRAS,
  resampleTrilinear,
  clipAndZScore,
  type CanonicalVolume,
} from '../preprocessing';
import { reorientLabelmapToSource } from '../postprocessing';
import {
  estimateSlidingWindowMemory,
  runSlidingWindow,
  type SlidingWindowProgress,
} from '../slidingWindow';

// Refuse to run if the estimated peak memory exceeds this. Browsers typically
// OOM tabs around 2 GB on 32-bit V8 and 4 GB on 64-bit; 1.5 GB is a safe cap
// that leaves headroom for everything else (ORT, viewer, etc.).
const MAX_ESTIMATED_BYTES = 1.5 * 1024 * 1024 * 1024;

const TARGET_SPACING: [number, number, number] = [1.5, 1.5, 1.5];
const PATCH_SIZE: [number, number, number] = [160, 112, 112];
const NUM_CLASSES = 25;

const NORMALIZE = { lo: -64, hi: 1352, mean: 334.86, std: 259.03 };

export const VERTEBRAE_LABELS: Record<number, string> = {
  1: 'L5',
  2: 'L4',
  3: 'L3',
  4: 'L2',
  5: 'L1',
  6: 'T12',
  7: 'T11',
  8: 'T10',
  9: 'T9',
  10: 'T8',
  11: 'T7',
  12: 'T6',
  13: 'T5',
  14: 'T4',
  15: 'T3',
  16: 'T2',
  17: 'T1',
  18: 'C7',
  19: 'C6',
  20: 'C5',
  21: 'C4',
  22: 'C3',
  23: 'C2',
  24: 'C1',
};

export interface VertebraeOptions {
  onnxUrl: string;
  onProgress?: (stage: string, progress: number, total: number) => void;
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
  opts: VertebraeOptions
): Promise<VertebraeResult> {
  const { onnxUrl, onProgress } = opts;

  onProgress?.('Reorienting volume to RAS', 0, 4);
  const canonical: CanonicalVolume = reorientToRAS(volume);

  onProgress?.('Resampling to 1.5mm isotropic', 1, 4);
  const resampled = resampleTrilinear(
    canonical.data,
    canonical.shape,
    canonical.spacing,
    TARGET_SPACING
  );

  onProgress?.('Normalizing intensities', 2, 4);
  clipAndZScore(resampled.data, NORMALIZE.lo, NORMALIZE.hi, NORMALIZE.mean, NORMALIZE.std);

  const estBytes = estimateSlidingWindowMemory(resampled.shape, PATCH_SIZE, NUM_CLASSES);
  if (estBytes > MAX_ESTIMATED_BYTES) {
    const gb = (estBytes / 1024 / 1024 / 1024).toFixed(1);
    throw new Error(
      `Volume too large for in-browser inference (estimated peak ~${gb} GB after resampling ` +
        `to ${resampled.shape.join('×')}). Switch to "On AI server" or use a smaller field of view.`
    );
  }

  const labelmap = await runSlidingWindow(resampled.data, resampled.shape, {
    onnxUrl,
    patchSize: PATCH_SIZE,
    numClasses: NUM_CLASSES,
    stepSize: 0.5,
    onProgress: (p: SlidingWindowProgress) =>
      onProgress?.(`Inference patch ${p.patch}/${p.total}`, p.patch, p.total),
  });

  onProgress?.('Resampling labelmap to source', 3, 4);
  const back = reorientLabelmapToSource(labelmap, resampled.shape, canonical);

  onProgress?.('Done', 4, 4);
  return {
    data: back.data,
    width: back.width,
    height: back.height,
    depth: back.depth,
    labelNames: VERTEBRAE_LABELS,
  };
}
