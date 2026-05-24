import { resampleNearest } from './preprocessing';
import type { CanonicalVolume } from './preprocessing';

/**
 * Resample a canonical labelmap back to the OHIF source shape and reapply the
 * inverse of the RAS reorientation so the result lines up with the original
 * display set's (i, j, k) layout (slice-major, row-major, column-major within
 * each slice).
 *
 * The output buffer is laid out the same way as the input volume in
 * `extractDisplaySetVolume`: `data[k*H*W + j*W + i]` with W = sourceShape[0],
 * H = sourceShape[1].
 */
export function reorientLabelmapToSource(
  labelmap: Uint8Array,
  canonicalShape: [number, number, number],
  canonical: CanonicalVolume
): { data: Uint8Array; width: number; height: number; depth: number } {
  // 1. Resample from canonical resampled shape back to canonical-source shape
  //    (i.e. the shape that resulted from reorientToRAS before resampling).
  const reorientedShape: [number, number, number] = [
    canonical.shape[0],
    canonical.shape[1],
    canonical.shape[2],
  ];
  const resampled = resampleNearest(labelmap, canonicalShape, reorientedShape);

  // 2. Undo the permutation + flips to get back to OHIF (i, j, k) order.
  const sourceShape = canonical.sourceShape; // (i=width, j=height, k=depth)
  const [W, H, D] = sourceShape;
  const out = new Uint8Array(W * H * D);

  const outAxisFromOhif = canonical.permutation;
  const outFlipFromOhif = canonical.flips;
  const outShape = canonical.shape; // (z, y, x)

  // For each output voxel in OHIF order (i, j, k), find the canonical (z, y, x).
  // canonical_axis[d] holds the OHIF axis index it maps to.
  // We need the inverse: OHIF axis a → canonical axis d such that outAxisFromOhif[d] = a.
  const ohifToCanonical: [number, number, number] = [0, 0, 0];
  ohifToCanonical[outAxisFromOhif[0]] = 0;
  ohifToCanonical[outAxisFromOhif[1]] = 1;
  ohifToCanonical[outAxisFromOhif[2]] = 2;

  const srcIndex = [0, 0, 0]; // (z, y, x)
  const sStrides: [number, number, number] = [outShape[1] * outShape[2], outShape[2], 1]; // canonical (z,y,x)

  let outIdx = 0;
  for (let k = 0; k < D; k++) {
    const canK = ohifToCanonical[2]; // canonical axis that maps from OHIF k
    const flipK = outFlipFromOhif[canK];
    const canKValue = flipK === 1 ? k : outShape[canK] - 1 - k;
    srcIndex[canK] = canKValue;
    for (let j = 0; j < H; j++) {
      const canJ = ohifToCanonical[1];
      const flipJ = outFlipFromOhif[canJ];
      const canJValue = flipJ === 1 ? j : outShape[canJ] - 1 - j;
      srcIndex[canJ] = canJValue;
      for (let i = 0; i < W; i++) {
        const canI = ohifToCanonical[0];
        const flipI = outFlipFromOhif[canI];
        const canIValue = flipI === 1 ? i : outShape[canI] - 1 - i;
        srcIndex[canI] = canIValue;
        const flat =
          srcIndex[0] * sStrides[0] + srcIndex[1] * sStrides[1] + srcIndex[2] * sStrides[2];
        out[outIdx++] = resampled[flat];
      }
    }
  }

  return { data: out, width: W, height: H, depth: D };
}
