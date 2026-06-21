import { getCenterExtent } from './getCenterExtent';

/**
 * Extracts a single 3D world point [x, y, z] from a measurement, trying the
 * most reliable sources first and falling back as needed:
 *   1. measurement.points[0]
 *   2. measurement.data.handles.points[0]
 *   3. measurement.metadata.planeRestriction.point
 *   4. the center of the measurement's bounding box (getCenterExtent)
 *
 * Note: the final fallback always returns a point (e.g. [0, 0, 0] for an empty
 * measurement), so callers that need to distinguish "no real point" from the
 * origin must guard on measurement.points themselves.
 */
export const getMeasurementWorldPoint = measurement => {
  const pointMeasurementPoint = measurement?.points?.[0];
  if (pointMeasurementPoint?.length === 3) {
    return pointMeasurementPoint;
  }

  const handlePoint = measurement?.data?.handles?.points?.[0];
  if (handlePoint?.length === 3) {
    return handlePoint;
  }

  const metadataPoint = measurement?.metadata?.planeRestriction?.point;
  if (metadataPoint?.length === 3) {
    return metadataPoint;
  }

  const { center } = getCenterExtent(measurement);
  return center;
};
