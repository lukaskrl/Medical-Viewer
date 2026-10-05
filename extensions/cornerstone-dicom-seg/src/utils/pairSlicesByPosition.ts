type ImagePlane = {
  imagePositionPatient?: number[];
  rowCosines?: number[];
  columnCosines?: number[];
};

/**
 * For each segmentation slice, the index of the reference image at the same
 * position along the slice normal.
 *
 * Segmentation frames and reference images are not in the same order: NIfTI
 * frames follow the file's voxel order, while OHIF sorts a reconstructable
 * reference by patient position (sortImagesByPatientPosition), so pairing them
 * by index can mirror the stack. Returns null when either side lacks the plane
 * metadata needed to compare positions.
 */
export function pairSlicesByPosition(
  segPlanes: (ImagePlane | undefined)[],
  referencePlanes: (ImagePlane | undefined)[]
): number[] | null {
  const { rowCosines, columnCosines } = segPlanes[0] || {};
  if (
    !rowCosines ||
    !columnCosines ||
    !referencePlanes.length ||
    [...segPlanes, ...referencePlanes].some(plane => !plane?.imagePositionPatient)
  ) {
    return null;
  }

  const normal = [
    rowCosines[1] * columnCosines[2] - rowCosines[2] * columnCosines[1],
    rowCosines[2] * columnCosines[0] - rowCosines[0] * columnCosines[2],
    rowCosines[0] * columnCosines[1] - rowCosines[1] * columnCosines[0],
  ];
  const distanceAlongNormal = ({ imagePositionPatient: position }: ImagePlane) =>
    position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2];

  const referenceDistances = referencePlanes.map(distanceAlongNormal);

  return segPlanes.map(plane => {
    const distance = distanceAlongNormal(plane);
    let nearest = 0;
    for (let i = 1; i < referenceDistances.length; i++) {
      if (
        Math.abs(referenceDistances[i] - distance) <
        Math.abs(referenceDistances[nearest] - distance)
      ) {
        nearest = i;
      }
    }
    return nearest;
  });
}
