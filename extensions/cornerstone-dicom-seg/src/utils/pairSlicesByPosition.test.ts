import { pairSlicesByPosition } from './pairSlicesByPosition';

const axialPlane = z => ({
  imagePositionPatient: [10, 20, z],
  rowCosines: [1, 0, 0],
  columnCosines: [0, 1, 0],
});

describe('pairSlicesByPosition', () => {
  it('pairs slices stored in opposite orders by position, not by index', () => {
    const segPlanes = [30, 32, 34, 36].map(axialPlane);
    // OHIF sorts a reconstructable reference by descending position.
    const referencePlanes = [36, 34, 32, 30].map(axialPlane);

    expect(pairSlicesByPosition(segPlanes, referencePlanes)).toEqual([3, 2, 1, 0]);
  });

  it('pairs a segmentation covering part of the reference with the slices it covers', () => {
    const segPlanes = [32, 34].map(axialPlane);
    const referencePlanes = [30, 32, 34, 36].map(axialPlane);

    expect(pairSlicesByPosition(segPlanes, referencePlanes)).toEqual([1, 2]);
  });

  it('measures position along the slice normal for oblique slices', () => {
    const tilted = { rowCosines: [1, 0, 0], columnCosines: [0, Math.SQRT1_2, Math.SQRT1_2] };
    // Normal is (0, -1/√2, 1/√2); in-plane shifts along columns do not move a slice.
    const plane = (offset, inPlaneShift) => ({
      ...tilted,
      imagePositionPatient: [0, -offset * Math.SQRT1_2 + inPlaneShift, offset * Math.SQRT1_2 + inPlaneShift],
    });

    const segPlanes = [plane(0, 5), plane(1, 5)];
    const referencePlanes = [plane(1, 0), plane(0, 0)];

    expect(pairSlicesByPosition(segPlanes, referencePlanes)).toEqual([1, 0]);
  });

  it('returns null when plane metadata is missing so callers can pair by index', () => {
    const segPlanes = [axialPlane(30), undefined];
    const referencePlanes = [axialPlane(30), axialPlane(32)];

    expect(pairSlicesByPosition(segPlanes, referencePlanes)).toBeNull();
    expect(pairSlicesByPosition([axialPlane(30)], [])).toBeNull();
  });
});
