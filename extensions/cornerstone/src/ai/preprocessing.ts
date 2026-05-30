import type { ImageVolume } from '../utils/extractDisplaySetVolume';

export interface CanonicalVolume {
  /** Float32 voxels, in (z, y, x) array order — z = superior axis. */
  data: Float32Array;
  shape: [number, number, number]; // (z, y, x)
  spacing: [number, number, number]; // (z, y, x) in mm
  /** Axis permutation applied to map (OHIF i, j, k) → canonical (x, y, z). */
  permutation: [number, number, number];
  /** Per-axis flips applied after permutation (1 = no flip, -1 = flipped). */
  flips: [number, number, number];
  /** Shape of the OHIF source volume in (i, j, k) order (columns, rows, slices). */
  sourceShape: [number, number, number];
}

/**
 * Reorient an OHIF display-set volume to a canonical (S, A, R) layout matching
 * what ai/main.py does (nibabel.as_closest_canonical + transpose(2,1,0)):
 *   - axis 0 of the output corresponds to the superior-inferior axis (S+)
 *   - axis 1 corresponds to the anterior-posterior axis (A+)
 *   - axis 2 corresponds to the right-left axis (R+)
 *
 * For a standard axial CT (rowDir ≈ +X_LPS, columnDir ≈ +Y_LPS, sliceDir ≈ +Z_LPS):
 *   OHIF (col i, row j, slice k) ≈ (L→R reversed, A→P, I→S) in LPS
 *   → permutation = (slice, row, col), with the column axis flipped to RAS+R.
 *
 * The permutation/flips are returned so the inverse can be applied to the
 * predicted labelmap.
 */
export function reorientToRAS(volume: ImageVolume): CanonicalVolume {
  const { data, width, height, depth, rowDirection, columnDirection, sliceDirection, spacing } =
    volume;

  // The three OHIF axes expressed in LPS world coordinates.
  // RAS+ = (-L, -P, +S), so for each canonical RAS+ axis we pick the OHIF axis
  // whose direction has the strongest component along that RAS+ axis.
  const lpsAxes: [number, number, number][] = [rowDirection, columnDirection, sliceDirection];

  // For each canonical RAS+ axis (R = -L = -x_lps, A = -P = -y_lps, S = +z_lps),
  // find the dominant OHIF axis and sign.
  const rasTargets: [number, number, number][] = [
    [-1, 0, 0], // R+ in LPS
    [0, -1, 0], // A+ in LPS
    [0, 0, 1], // S+ in LPS
  ];

  const matchedAxis: number[] = [-1, -1, -1];
  const matchedSign: number[] = [1, 1, 1];

  for (let ras = 0; ras < 3; ras++) {
    let best = 0;
    let bestAxis = -1;
    let bestSign = 1;
    for (let ohif = 0; ohif < 3; ohif++) {
      if (matchedAxis.includes(ohif)) {
        continue;
      }
      const a = lpsAxes[ohif];
      const t = rasTargets[ras];
      const dot = a[0] * t[0] + a[1] * t[1] + a[2] * t[2];
      const abs = Math.abs(dot);
      if (abs > best) {
        best = abs;
        bestAxis = ohif;
        bestSign = dot >= 0 ? 1 : -1;
      }
    }
    if (bestAxis === -1) {
      // Degenerate orientation — fall back to default axial mapping.
      for (let ohif = 0; ohif < 3; ohif++) {
        if (!matchedAxis.includes(ohif)) {
          bestAxis = ohif;
          break;
        }
      }
    }
    matchedAxis[ras] = bestAxis;
    matchedSign[ras] = bestSign;
  }

  // Canonical output is (S, A, R) — axis order [2, 1, 0] of the RAS triplet.
  // matchedAxis[0] is the OHIF axis that maps to R (output axis 2).
  // matchedAxis[1] is the OHIF axis that maps to A (output axis 1).
  // matchedAxis[2] is the OHIF axis that maps to S (output axis 0).
  const outAxisFromOhif: [number, number, number] = [
    matchedAxis[2], // output z (S) ← which OHIF axis?
    matchedAxis[1], // output y (A) ← which OHIF axis?
    matchedAxis[0], // output x (R) ← which OHIF axis?
  ];
  const outFlipFromOhif: [number, number, number] = [
    matchedSign[2], // output z flip
    matchedSign[1], // output y flip
    matchedSign[0], // output x flip
  ];

  const sourceShape: [number, number, number] = [width, height, depth]; // (i, j, k)
  const outShape: [number, number, number] = [
    sourceShape[outAxisFromOhif[0]],
    sourceShape[outAxisFromOhif[1]],
    sourceShape[outAxisFromOhif[2]],
  ];

  const sourceSpacing: [number, number, number] = [spacing[0], spacing[1], spacing[2]];
  const outSpacing: [number, number, number] = [
    sourceSpacing[outAxisFromOhif[0]],
    sourceSpacing[outAxisFromOhif[1]],
    sourceSpacing[outAxisFromOhif[2]],
  ];

  const out = new Float32Array(outShape[0] * outShape[1] * outShape[2]);

  // Strides for the source data: data[k*H*W + j*W + i] with W=width, H=height.
  const sStrides: [number, number, number] = [1, width, width * height]; // (i, j, k)

  // For each output voxel (z, y, x), figure out which source (i, j, k) it maps to.
  // out_axis 0 (z) ← OHIF axis outAxisFromOhif[0], flipped if outFlipFromOhif[0]=-1
  // out_axis 1 (y) ← OHIF axis outAxisFromOhif[1], flipped if outFlipFromOhif[1]=-1
  // out_axis 2 (x) ← OHIF axis outAxisFromOhif[2], flipped if outFlipFromOhif[2]=-1
  const [Z, Y, X] = outShape;
  const srcIndex = [0, 0, 0]; // (i, j, k)
  let outIdx = 0;
  for (let z = 0; z < Z; z++) {
    const zSrc = outFlipFromOhif[0] === 1 ? z : outShape[0] - 1 - z;
    srcIndex[outAxisFromOhif[0]] = zSrc;
    for (let y = 0; y < Y; y++) {
      const ySrc = outFlipFromOhif[1] === 1 ? y : outShape[1] - 1 - y;
      srcIndex[outAxisFromOhif[1]] = ySrc;
      for (let x = 0; x < X; x++) {
        const xSrc = outFlipFromOhif[2] === 1 ? x : outShape[2] - 1 - x;
        srcIndex[outAxisFromOhif[2]] = xSrc;
        const flat =
          srcIndex[0] * sStrides[0] + srcIndex[1] * sStrides[1] + srcIndex[2] * sStrides[2];
        out[outIdx++] = data[flat];
      }
    }
  }

  return {
    data: out,
    shape: outShape,
    spacing: outSpacing,
    permutation: outAxisFromOhif,
    flips: outFlipFromOhif,
    sourceShape,
  };
}

/**
 * Trilinear resampling of a 3D Float32 volume from `srcSpacing` to `targetSpacing`.
 * Pure JS; intended for volumes up to ~512³. For larger volumes consider a
 * WebGPU compute shader.
 */
export function resampleTrilinear(
  src: Float32Array,
  srcShape: [number, number, number],
  srcSpacing: [number, number, number],
  targetSpacing: [number, number, number]
): { data: Float32Array; shape: [number, number, number] } {
  const [SZ, SY, SX] = srcShape;
  const newShape: [number, number, number] = [
    Math.max(1, Math.round((SZ * srcSpacing[0]) / targetSpacing[0])),
    Math.max(1, Math.round((SY * srcSpacing[1]) / targetSpacing[1])),
    Math.max(1, Math.round((SX * srcSpacing[2]) / targetSpacing[2])),
  ];
  if (newShape[0] === SZ && newShape[1] === SY && newShape[2] === SX) {
    return { data: src, shape: srcShape };
  }
  const [NZ, NY, NX] = newShape;
  const out = new Float32Array(NZ * NY * NX);

  // Scale factor: src coord = (target coord + 0.5) * scale - 0.5 (pixel-center align)
  const sz = SZ / NZ;
  const sy = SY / NY;
  const sx = SX / NX;

  const rowStride = SX;
  const sliceStride = SX * SY;

  let o = 0;
  for (let z = 0; z < NZ; z++) {
    const zf = Math.min(SZ - 1, Math.max(0, (z + 0.5) * sz - 0.5));
    const z0 = Math.floor(zf);
    const z1 = Math.min(SZ - 1, z0 + 1);
    const tz = zf - z0;
    for (let y = 0; y < NY; y++) {
      const yf = Math.min(SY - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(yf);
      const y1 = Math.min(SY - 1, y0 + 1);
      const ty = yf - y0;
      for (let x = 0; x < NX; x++) {
        const xf = Math.min(SX - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(xf);
        const x1 = Math.min(SX - 1, x0 + 1);
        const tx = xf - x0;

        const i000 = z0 * sliceStride + y0 * rowStride + x0;
        const i100 = z0 * sliceStride + y0 * rowStride + x1;
        const i010 = z0 * sliceStride + y1 * rowStride + x0;
        const i110 = z0 * sliceStride + y1 * rowStride + x1;
        const i001 = z1 * sliceStride + y0 * rowStride + x0;
        const i101 = z1 * sliceStride + y0 * rowStride + x1;
        const i011 = z1 * sliceStride + y1 * rowStride + x0;
        const i111 = z1 * sliceStride + y1 * rowStride + x1;

        const c00 = src[i000] * (1 - tx) + src[i100] * tx;
        const c10 = src[i010] * (1 - tx) + src[i110] * tx;
        const c01 = src[i001] * (1 - tx) + src[i101] * tx;
        const c11 = src[i011] * (1 - tx) + src[i111] * tx;
        const c0 = c00 * (1 - ty) + c10 * ty;
        const c1 = c01 * (1 - ty) + c11 * ty;
        out[o++] = c0 * (1 - tz) + c1 * tz;
      }
    }
  }

  return { data: out, shape: newShape };
}

/**
 * Nearest-neighbour resampling of an integer labelmap.
 */
export function resampleNearest(
  src: Uint8Array | Uint16Array,
  srcShape: [number, number, number],
  targetShape: [number, number, number]
): Uint8Array {
  const [SZ, SY, SX] = srcShape;
  const [NZ, NY, NX] = targetShape;
  if (SZ === NZ && SY === NY && SX === NX) {
    return src instanceof Uint8Array ? src : new Uint8Array(src);
  }
  const out = new Uint8Array(NZ * NY * NX);
  const sz = SZ / NZ;
  const sy = SY / NY;
  const sx = SX / NX;
  const rowStride = SX;
  const sliceStride = SX * SY;
  let o = 0;
  for (let z = 0; z < NZ; z++) {
    const zSrc = Math.min(SZ - 1, Math.floor((z + 0.5) * sz));
    for (let y = 0; y < NY; y++) {
      const ySrc = Math.min(SY - 1, Math.floor((y + 0.5) * sy));
      for (let x = 0; x < NX; x++) {
        const xSrc = Math.min(SX - 1, Math.floor((x + 0.5) * sx));
        out[o++] = src[zSrc * sliceStride + ySrc * rowStride + xSrc];
      }
    }
  }
  return out;
}

/**
 * Clip to [lo, hi] and z-score with given mean/std. Modifies the array in place.
 */
export function clipAndZScore(
  data: Float32Array,
  lo: number,
  hi: number,
  mean: number,
  std: number
): Float32Array {
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (v < lo) v = lo;
    else if (v > hi) v = hi;
    data[i] = (v - mean) / std;
  }
  return data;
}

/**
 * Per-image z-score normalization (nnU-Net `ZScoreNormalization`, used for the
 * MRI model where `use_mask_for_norm` is false). Computes mean/std over the
 * whole volume and applies `(v - mean) / max(std, 1e-8)` in place.
 */
export function zScorePerImage(data: Float32Array): Float32Array {
  const n = data.length;
  if (n === 0) return data;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / n);
  const denom = std > 1e-8 ? std : 1e-8;
  for (let i = 0; i < n; i++) {
    data[i] = (data[i] - mean) / denom;
  }
  return data;
}
