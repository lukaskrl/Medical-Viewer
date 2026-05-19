import { cache, metaData } from '@cornerstonejs/core';
import { segmentation as cornerstoneToolsSegmentation } from '@cornerstonejs/tools';

export interface SegmentationVolume {
  /** Concatenated pixel data for the full 3D volume (slice 0 first, then slice 1, ...). */
  data: Uint8Array | Uint16Array;
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
  /** Unit direction vector along the X (columns) axis, in LPS. */
  rowDirection: [number, number, number];
  /** Unit direction vector along the Y (rows) axis, in LPS. */
  columnDirection: [number, number, number];
  /** Unit direction vector along the K (slice) axis, in LPS. */
  sliceDirection: [number, number, number];
  /** Label/name of the segmentation, useful for filenames. */
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

/**
 * Build a 3D labelmap volume + geometry from a cornerstone segmentation.
 *
 * The segmentation is stored slice-by-slice in cornerstone's image cache. We
 * stack the per-slice pixel buffers in the order of `labelmap.imageIds` and
 * derive geometry from the corresponding referenced image metadata.
 */
export function extractSegmentationVolume(segmentationId: string): SegmentationVolume {
  const segmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);
  if (!segmentation) {
    throw new Error(`Segmentation ${segmentationId} not found`);
  }

  const labelmap = segmentation.representationData?.Labelmap as
    | { imageIds?: string[]; referencedImageIds?: string[] }
    | undefined;

  const imageIds = labelmap?.imageIds;
  if (!imageIds?.length) {
    throw new Error('Segmentation has no labelmap imageIds — cannot export as volume');
  }

  const segImages = imageIds.map(id => cache.getImage(id));
  if (segImages.some(img => !img)) {
    throw new Error('One or more segmentation slices are not in the cornerstone image cache');
  }

  const first = segImages[0];
  const width = first.columns ?? first.width;
  const height = first.rows ?? first.height;

  // Pick a typed-array constructor matching the in-memory pixel data of slice 0.
  const samplePixels = first.getPixelData();
  const TypedArrayCtor: typeof Uint8Array | typeof Uint16Array =
    samplePixels instanceof Uint16Array ? Uint16Array : Uint8Array;

  const sliceSize = width * height;
  const depth = segImages.length;
  const data = new TypedArrayCtor(sliceSize * depth);

  segImages.forEach((segImage, sliceIndex) => {
    const pixelData = segImage.getPixelData();
    if (pixelData.length !== sliceSize) {
      throw new Error(
        `Slice ${sliceIndex} pixel data length ${pixelData.length} does not match ${sliceSize}`
      );
    }
    data.set(pixelData as Uint8Array | Uint16Array, sliceIndex * sliceSize);
  });

  // Geometry — use the referenced (source image) metadata. Falls back to the
  // segmentation image's own metadata if the referenced image isn't there.
  const referencedImageIds: string[] = (labelmap.referencedImageIds || []).filter(Boolean);
  const geometryImageIds =
    referencedImageIds.length === imageIds.length
      ? referencedImageIds
      : segImages.map(img => img.referencedImageId || img.imageId);

  const firstPlane = metaData.get('imagePlaneModule', geometryImageIds[0]);
  if (!firstPlane) {
    throw new Error('Cannot resolve imagePlaneModule metadata for the first slice');
  }

  const rowDirection = normalize(firstPlane.rowCosines as [number, number, number]);
  const columnDirection = normalize(firstPlane.columnCosines as [number, number, number]);
  const origin = firstPlane.imagePositionPatient.slice(0, 3) as [number, number, number];

  // DICOM imagePlaneModule swaps the meaning of rowPixelSpacing/columnPixelSpacing
  // relative to the (rowDirection, columnDirection) pair: rowPixelSpacing is the
  // spacing *between rows* (i.e. along the columnDirection) and vice versa.
  const columnSpacing = firstPlane.columnPixelSpacing as number;
  const rowSpacing = firstPlane.rowPixelSpacing as number;

  let sliceDirection: [number, number, number];
  let sliceSpacing: number;
  if (depth >= 2) {
    const secondPlane = metaData.get('imagePlaneModule', geometryImageIds[1]);
    const secondOrigin = secondPlane?.imagePositionPatient?.slice(0, 3) as
      | [number, number, number]
      | undefined;

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

  const segmentationInOHIF = segmentation as { label?: string };

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
    label: segmentationInOHIF.label || 'segmentation',
  };
}
