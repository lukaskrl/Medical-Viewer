import { cache, imageLoader, metaData } from '@cornerstonejs/core';

export interface ImageVolume {
  /** Float32 HU values, concatenated slice-by-slice (slice 0 first). */
  data: Float32Array;
  /** Number of voxels along the X (columns) axis. */
  width: number;
  /** Number of voxels along the Y (rows) axis. */
  height: number;
  /** Number of slices along the K (slice) axis. */
  depth: number;
  /** Voxel spacing in mm: [columnSpacing, rowSpacing, sliceSpacing]. */
  spacing: [number, number, number];
  /** Origin of voxel (0,0,0) in DICOM patient (LPS) coordinates, mm. */
  origin: [number, number, number];
  /** Unit direction along the X (columns) axis, in LPS. */
  rowDirection: [number, number, number];
  /** Unit direction along the Y (rows) axis, in LPS. */
  columnDirection: [number, number, number];
  /** Unit direction along the K (slice) axis, in LPS. */
  sliceDirection: [number, number, number];
  /** Series description / display set label, used for filenames. */
  label: string;
}

const subtract = (
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const norm = (v: [number, number, number]): number =>
  Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

const normalize = (v: [number, number, number]): [number, number, number] => {
  const n = norm(v);
  if (n === 0) {
    return [0, 0, 0];
  }
  return [v[0] / n, v[1] / n, v[2] / n];
};

const cross = (
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

interface ProgressOptions {
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Build a Float32 HU volume + geometry from an OHIF display set.
 *
 * Walks `displaySet.imageIds` in order, loading each slice from the cornerstone
 * cache (fetching it through the registered image loader if necessary), and
 * stacking the rescaled (slope * raw + intercept) pixel values into a single
 * contiguous Float32Array. Geometry is read from each slice's
 * `imagePlaneModule` metadata.
 *
 * The output matches the layout `buildNiftiBuffer` expects so the volume can
 * be serialised as a NIfTI for upload to the AI inference service.
 */
export async function extractDisplaySetVolume(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  displaySet: any,
  { onProgress }: ProgressOptions = {}
): Promise<ImageVolume> {
  const imageIds: string[] | undefined = displaySet?.imageIds;
  if (!imageIds?.length) {
    throw new Error('Display set has no imageIds — cannot extract volume');
  }

  const depth = imageIds.length;

  // Load slice 0 first so we have geometry + dimensions for the output array.
  const firstImage = (await imageLoader.loadAndCacheImage(imageIds[0])) as {
    width?: number;
    columns?: number;
    height?: number;
    rows?: number;
    getPixelData: () => ArrayLike<number>;
  };

  const width = firstImage.columns ?? firstImage.width;
  const height = firstImage.rows ?? firstImage.height;
  if (!width || !height) {
    throw new Error('First slice has no width/height');
  }

  const firstPlane = metaData.get('imagePlaneModule', imageIds[0]);
  if (!firstPlane) {
    throw new Error('imagePlaneModule metadata missing for slice 0');
  }

  const rowDirection = normalize(firstPlane.rowCosines as [number, number, number]);
  const columnDirection = normalize(firstPlane.columnCosines as [number, number, number]);
  const origin = (firstPlane.imagePositionPatient as number[]).slice(0, 3) as [
    number,
    number,
    number,
  ];

  // DICOM rowPixelSpacing = spacing along column direction (between rows), and
  // vice versa — match the convention used by extractSegmentationVolume.
  const columnSpacing = firstPlane.columnPixelSpacing as number;
  const rowSpacing = firstPlane.rowPixelSpacing as number;

  let sliceDirection: [number, number, number];
  let sliceSpacing: number;
  if (depth >= 2) {
    const secondPlane = metaData.get('imagePlaneModule', imageIds[1]);
    const secondOrigin = (secondPlane?.imagePositionPatient as number[] | undefined)?.slice(
      0,
      3
    ) as [number, number, number] | undefined;
    if (secondOrigin) {
      const delta = subtract(secondOrigin, origin);
      sliceSpacing = norm(delta);
      sliceDirection = sliceSpacing > 0 ? normalize(delta) : cross(rowDirection, columnDirection);
      if (sliceSpacing === 0) {
        sliceSpacing = (firstPlane.sliceThickness as number) || 1;
      }
    } else {
      sliceDirection = cross(rowDirection, columnDirection);
      sliceSpacing = (firstPlane.sliceThickness as number) || 1;
    }
  } else {
    sliceDirection = cross(rowDirection, columnDirection);
    sliceSpacing = (firstPlane.sliceThickness as number) || 1;
  }

  const sliceSize = width * height;
  const data = new Float32Array(sliceSize * depth);

  onProgress?.(0, depth);

  const copySlice = (
    pixels: ArrayLike<number>,
    sliceIndex: number,
    slope: number,
    intercept: number
  ) => {
    const offset = sliceIndex * sliceSize;
    if (slope === 1 && intercept === 0) {
      for (let i = 0; i < sliceSize; i++) {
        data[offset + i] = pixels[i];
      }
    } else {
      for (let i = 0; i < sliceSize; i++) {
        data[offset + i] = pixels[i] * slope + intercept;
      }
    }
  };

  // Read the rescale params for slice 0 and reuse if they don't vary per slice.
  const readRescale = (imageId: string): { slope: number; intercept: number } => {
    const mod = metaData.get('modalityLutModule', imageId) || {};
    const slope = typeof mod.rescaleSlope === 'number' ? mod.rescaleSlope : 1;
    const intercept = typeof mod.rescaleIntercept === 'number' ? mod.rescaleIntercept : 0;
    return { slope, intercept };
  };

  const first = readRescale(imageIds[0]);
  copySlice(firstImage.getPixelData(), 0, first.slope, first.intercept);
  onProgress?.(1, depth);

  for (let i = 1; i < depth; i++) {
    const imageId = imageIds[i];
    const cached = cache.getImage(imageId);
    const image = (cached ?? (await imageLoader.loadAndCacheImage(imageId))) as {
      getPixelData: () => ArrayLike<number>;
    };
    const { slope, intercept } = readRescale(imageId);
    copySlice(image.getPixelData(), i, slope, intercept);
    onProgress?.(i + 1, depth);
  }

  const label: string =
    displaySet.SeriesDescription || displaySet.label || displaySet.SeriesInstanceUID || 'volume';

  return {
    data,
    width,
    height,
    depth,
    spacing: [columnSpacing, rowSpacing, sliceSpacing],
    origin,
    rowDirection,
    columnDirection,
    sliceDirection,
    label,
  };
}
