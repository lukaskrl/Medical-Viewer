import type { Types as CSToolsTypes } from '@cornerstonejs/tools';

type CSSegmentation = CSToolsTypes.Segmentation;
type CSSegment = CSToolsTypes.Segment;
type LabelmapSegmentationData = CSToolsTypes.LabelmapSegmentationData;

/**
 * Cornerstone's segment plus the runtime fields OHIF attaches.
 *
 * `algorithmType` / `algorithmName` are written into the DICOM SEG export;
 * `color` mirrors the active UI color so adapters can serialize it without a
 * separate lookup.
 */
export type OHIFSegment = CSSegment & {
  algorithmType?: string;
  algorithmName?: string;
  color?: number[];
};

/**
 * Cornerstone's segmentation plus OHIF runtime fields.
 *
 * `predecessorImageId` is set when the segmentation was created against a
 * specific reference image (e.g. for "Update" operations on a stored SEG);
 * it propagates back into the DICOM SEG/RTSS export so the report references
 * the same series.
 */
export type OHIFSegmentation = CSSegmentation & {
  predecessorImageId?: string;
  segments: { [segmentIndex: number]: OHIFSegment };
};

/**
 * The "stack" arm of the labelmap union: the per-slice segmentation image ids.
 * Used when reconstructing the volume for export.
 */
export type OHIFStackLabelmapData = LabelmapSegmentationData & {
  imageIds?: string[];
  referencedImageIds?: string[];
};
