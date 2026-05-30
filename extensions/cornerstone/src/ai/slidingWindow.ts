import { getInferenceSession, makeTensor } from './ortSession';

export interface SlidingWindowProgress {
  patch: number;
  total: number;
}

/**
 * Build a 3D Gaussian importance map matching nnU-Net v1 defaults:
 * sigma_scale = 1/8 of each patch dim, normalized so max = 1, floor non-zero.
 */
export function buildGaussianMap(patchSize: [number, number, number]): Float32Array {
  const [Pz, Py, Px] = patchSize;
  const sigmaZ = Pz / 8;
  const sigmaY = Py / 8;
  const sigmaX = Px / 8;
  const cz = (Pz - 1) / 2;
  const cy = (Py - 1) / 2;
  const cx = (Px - 1) / 2;

  const gz = new Float32Array(Pz);
  const gy = new Float32Array(Py);
  const gx = new Float32Array(Px);
  for (let i = 0; i < Pz; i++) gz[i] = Math.exp(-((i - cz) ** 2) / (2 * sigmaZ * sigmaZ));
  for (let i = 0; i < Py; i++) gy[i] = Math.exp(-((i - cy) ** 2) / (2 * sigmaY * sigmaY));
  for (let i = 0; i < Px; i++) gx[i] = Math.exp(-((i - cx) ** 2) / (2 * sigmaX * sigmaX));

  const map = new Float32Array(Pz * Py * Px);
  let maxV = 0;
  let o = 0;
  for (let z = 0; z < Pz; z++) {
    const gZ = gz[z];
    for (let y = 0; y < Py; y++) {
      const gZY = gZ * gy[y];
      for (let x = 0; x < Px; x++) {
        const v = gZY * gx[x];
        map[o++] = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  let minNonZero = Infinity;
  for (let i = 0; i < map.length; i++) {
    if (map[i] > 0 && map[i] < minNonZero) minNonZero = map[i];
  }
  if (!isFinite(minNonZero)) minNonZero = 1e-6;
  for (let i = 0; i < map.length; i++) {
    map[i] = (map[i] === 0 ? minNonZero : map[i]) / maxV;
  }
  return map;
}

function patchStarts(size: number, patch: number, step: number): number[] {
  const starts: number[] = [];
  for (let s = 0; s + patch <= size; s += step) {
    starts.push(s);
  }
  const last = size - patch;
  if (last >= 0 && (starts.length === 0 || starts[starts.length - 1] !== last)) {
    starts.push(last);
  }
  if (starts.length === 0) {
    starts.push(0);
  }
  return starts;
}

export interface SlidingWindowOptions {
  onnxUrl: string;
  patchSize: [number, number, number]; // (z, y, x)
  numClasses: number;
  stepSize?: number; // 0.5 = 50% overlap
  inputName?: string;
  outputName?: string;
  onProgress?: (p: SlidingWindowProgress) => void;
}

/**
 * Estimate peak heap usage in bytes for a sliding-window run with the given
 * inputs. Caller can use this to refuse before we OOM the tab.
 */
export function estimateSlidingWindowMemory(
  shape: [number, number, number],
  patchSize: [number, number, number],
  numClasses: number
): number {
  const [D, H, W] = shape;
  const [pd, ph, pw] = patchSize;
  const PD = Math.max(D, pd);
  const PH = Math.max(H, ph);
  const PW = Math.max(W, pw);
  const padded = PD * PH * PW * 4;
  const aggLabel = PD * PH * PW; // Uint8
  const aggScore = PD * PH * PW * 4; // Float32
  const patchInput = pd * ph * pw * 4;
  const patchOutput = pd * ph * pw * numClasses * 4; // ORT output
  // Plus generous overhead.
  return padded + aggLabel + aggScore + patchInput + patchOutput + 64 * 1024 * 1024;
}

/**
 * Run sliding-window inference and return an argmax labelmap.
 *
 * Memory-efficient strategy: for each output voxel we keep a running (label,
 * weighted-max-probability) pair instead of accumulating per-class logits.
 * This trades exact Gaussian-softmax averaging for a ~numClasses× memory
 * reduction — the difference vs. the canonical aggregation is negligible in
 * practice because the dominant class wins per voxel anyway.
 */
export async function runSlidingWindow(
  volume: Float32Array,
  shape: [number, number, number],
  opts: SlidingWindowOptions
): Promise<Uint8Array> {
  const [D, H, W] = shape;
  const [pd, ph, pw] = opts.patchSize;
  const stepSize = opts.stepSize ?? 0.5;
  const numClasses = opts.numClasses;

  // Pad to at least patch size, using the volume minimum (air on normalized CT).
  let padMin = Infinity;
  for (let i = 0; i < volume.length; i++) if (volume[i] < padMin) padMin = volume[i];
  const padD = Math.max(0, pd - D);
  const padH = Math.max(0, ph - H);
  const padW = Math.max(0, pw - W);
  const padDFront = padD >> 1;
  const padHFront = padH >> 1;
  const padWFront = padW >> 1;
  const PD = D + padD;
  const PH = H + padH;
  const PW = W + padW;
  const padded = new Float32Array(PD * PH * PW);
  if (padMin !== 0) {
    padded.fill(padMin);
  }
  for (let z = 0; z < D; z++) {
    for (let y = 0; y < H; y++) {
      const srcRow = (z * H + y) * W;
      const dstRow = ((z + padDFront) * PH + (y + padHFront)) * PW + padWFront;
      padded.set(volume.subarray(srcRow, srcRow + W), dstRow);
    }
  }

  const stepD = Math.max(1, Math.floor(pd * stepSize));
  const stepH = Math.max(1, Math.floor(ph * stepSize));
  const stepW = Math.max(1, Math.floor(pw * stepSize));
  const startsD = patchStarts(PD, pd, stepD);
  const startsH = patchStarts(PH, ph, stepH);
  const startsW = patchStarts(PW, pw, stepW);

  const total = startsD.length * startsH.length * startsW.length;
  const gaussian = buildGaussianMap(opts.patchSize);

  const SW_LOG = '[AI/slidingWindow]';
  console.log(
    `${SW_LOG} volume(z,y,x)=${D}×${H}×${W} patch=${pd}×${ph}×${pw} ` +
      `padded=${PD}×${PH}×${PW} padMin=${padMin.toFixed(3)} ` +
      `patches=${total} (${startsD.length}×${startsH.length}×${startsW.length}) ` +
      `numClasses=${numClasses}`
  );

  // Streaming argmax: per-voxel best label + the weighted max probability that
  // selected it. No per-class buffer over the padded volume.
  const aggregatedLabel = new Uint8Array(PD * PH * PW);
  const aggregatedScore = new Float32Array(PD * PH * PW);

  const session = await getInferenceSession(opts.onnxUrl);
  const inputName = opts.inputName || session.inputNames?.[0] || 'input';
  const outputName = opts.outputName || session.outputNames?.[0] || 'logits';

  const patchVoxels = pd * ph * pw;
  // Reuse these between patches to avoid per-iteration allocation pressure.
  const patchBuffer = new Float32Array(patchVoxels);
  const patchArgmax = new Uint8Array(patchVoxels);
  const patchMaxProb = new Float32Array(patchVoxels);

  let patchIndex = 0;
  for (const sd of startsD) {
    for (const sh of startsH) {
      for (const sw of startsW) {
        for (let z = 0; z < pd; z++) {
          for (let y = 0; y < ph; y++) {
            const srcRow = ((sd + z) * PH + (sh + y)) * PW + sw;
            const dstRow = (z * ph + y) * pw;
            patchBuffer.set(padded.subarray(srcRow, srcRow + pw), dstRow);
          }
        }

        const inputTensor = await makeTensor(patchBuffer, [1, 1, pd, ph, pw]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feeds: any = { [inputName]: inputTensor };
        const results = await session.run(feeds);
        const logits = results[outputName].data as Float32Array;

        // Compute per-voxel argmax + softmax-max in one pass without
        // materializing a full probability tensor.
        let patchFg = 0; // voxels whose argmax is a foreground class (debug)
        for (let v = 0; v < patchVoxels; v++) {
          let maxLogit = -Infinity;
          let bestClass = 0;
          for (let c = 0; c < numClasses; c++) {
            const x = logits[c * patchVoxels + v];
            if (x > maxLogit) {
              maxLogit = x;
              bestClass = c;
            }
          }
          // softmax probability of the argmax class:
          //   p = 1 / sum(exp(logit_c - maxLogit))
          let denom = 0;
          for (let c = 0; c < numClasses; c++) {
            denom += Math.exp(logits[c * patchVoxels + v] - maxLogit);
          }
          patchArgmax[v] = bestClass;
          patchMaxProb[v] = 1 / denom;
          if (bestClass !== 0) patchFg++;
        }
        // Log the raw model output for the first patch (and any patch with
        // foreground) so we can tell whether the ONNX itself sees anything.
        if (patchIndex === 0 || patchFg > 0) {
          let lmin = Infinity;
          let lmax = -Infinity;
          let lnan = 0;
          for (let i = 0; i < logits.length; i++) {
            const x = logits[i];
            if (Number.isNaN(x)) {
              lnan++;
              continue;
            }
            if (x < lmin) lmin = x;
            if (x > lmax) lmax = x;
          }
          console.log(
            `${SW_LOG} patch ${patchIndex} @[${sd},${sh},${sw}] ` +
              `logits[n=${logits.length} min=${lmin.toFixed(3)} max=${lmax.toFixed(3)} NaN=${lnan}] ` +
              `argmax-foreground voxels=${patchFg}/${patchVoxels}`
          );
        }

        // Streaming aggregation: per output voxel, keep the (label, weighted
        // probability) with the highest weighted probability seen so far.
        for (let z = 0; z < pd; z++) {
          for (let y = 0; y < ph; y++) {
            const dstRow = ((sd + z) * PH + (sh + y)) * PW + sw;
            const gRow = (z * ph + y) * pw;
            for (let x = 0; x < pw; x++) {
              const w = gaussian[gRow + x];
              const score = patchMaxProb[gRow + x] * w;
              const idx = dstRow + x;
              if (score > aggregatedScore[idx]) {
                aggregatedScore[idx] = score;
                aggregatedLabel[idx] = patchArgmax[gRow + x];
              }
            }
          }
        }

        patchIndex++;
        opts.onProgress?.({ patch: patchIndex, total });
        // Yield to the UI thread between patches.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  // Crop the padding.
  const out = new Uint8Array(D * H * W);
  for (let z = 0; z < D; z++) {
    const zSrc = z + padDFront;
    for (let y = 0; y < H; y++) {
      const ySrc = y + padHFront;
      const dstRow = (z * H + y) * W;
      const srcRow = (zSrc * PH + ySrc) * PW + padWFront;
      out.set(aggregatedLabel.subarray(srcRow, srcRow + W), dstRow);
    }
  }
  return out;
}
