import { DicomMetadataStore } from '@ohif/core';
import { normalizeLookupName } from './niftiUploadOptions';

/**
 * Picks the image series a NIfTI/NRRD segmentation hangs on by comparing voxel
 * grids, instead of asking the user. A segmentation whose grid matches a loaded
 * image series (real volume or blank canvas) references that series, so every
 * segmentation on the same grid shares one reference and renders together.
 */

// Modalities that are derived overlays, not image volumes. A segmentation must
// hang on an image series — never on another SEG/RT/SR/etc. Picking one of these
// as the reference makes the new seg reference an existing seg's display set,
// which then has no `.images` to render against (see _processExtraDisplaySets
// ForViewport) and the viewport snaps back to the referenced seg.
const NON_IMAGE_REFERENCE_MODALITIES = new Set([
  'SEG',
  'RTSTRUCT',
  'RTPLAN',
  'RTDOSE',
  'SR',
  'KO',
  'PR',
  'PMAP',
  'REG',
  'DOC',
]);

// Grids count as identical when they agree within these tolerances. Positions
// are compared as a fraction of the smallest pixel spacing so float32 NIfTI
// affines still match the DICOM series they were exported from.
const SPACING_RELATIVE_TOLERANCE = 1e-3;
const ORIENTATION_TOLERANCE = 1e-3;
const POSITION_TOLERANCE_FRACTION = 0.1;

function isImageReferenceSeries(series) {
  const modality = series?.instances?.[0]?.Modality || series?.Modality;
  return !!modality && !NON_IMAGE_REFERENCE_MODALITIES.has(modality);
}

/** World position (LPS) of slice `index` of a parsed NIfTI/NRRD volume. */
function getSlicePosition({ origin, direction, spacing }, index) {
  return [
    origin[0] + index * direction[6] * spacing[2],
    origin[1] + index * direction[7] * spacing[2],
    origin[2] + index * direction[8] * spacing[2],
  ];
}

/**
 * Grid signature of a parsed NIfTI/NRRD volume, in the same terms as the
 * synthetic instances the loader writes for it (see getSeriesGeometry).
 */
function getParsedVolumeGeometry(volume) {
  const { rows, columns, numSlices, spacing, direction } = volume;

  return {
    rows,
    columns,
    numSlices,
    pixelSpacing: [spacing[0], spacing[1]],
    orientation: direction.slice(0, 6),
    firstPosition: getSlicePosition(volume, 0),
    lastPosition: getSlicePosition(volume, numSlices - 1),
  };
}

function toNumbers(value, length) {
  const values = typeof value === 'string' ? value.split('\\') : value;
  if (!values || values.length < length) {
    return null;
  }
  const numbers = Array.from(values, Number).slice(0, length);
  return numbers.every(Number.isFinite) ? numbers : null;
}

/**
 * Grid signature of a single-frame image series in the metadata store, or null
 * when its instances lack the geometry needed to compare it.
 */
function getSeriesGeometry(series) {
  const instances = series?.instances;
  if (!instances?.length) {
    return null;
  }

  const firstInstance = instances[0];
  if (Number(firstInstance.NumberOfFrames) > 1) {
    return null;
  }

  const rows = Number(firstInstance.Rows);
  const columns = Number(firstInstance.Columns);
  const pixelSpacing = toNumbers(firstInstance.PixelSpacing, 2);
  const orientation = toNumbers(firstInstance.ImageOrientationPatient, 6);
  if (!rows || !columns || !pixelSpacing || !orientation) {
    return null;
  }

  const normal = [
    orientation[1] * orientation[5] - orientation[2] * orientation[4],
    orientation[2] * orientation[3] - orientation[0] * orientation[5],
    orientation[0] * orientation[4] - orientation[1] * orientation[3],
  ];

  let first = null;
  let last = null;
  for (const instance of instances) {
    const position = toNumbers(instance.ImagePositionPatient, 3);
    if (!position) {
      return null;
    }
    const distance = position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2];
    if (!first || distance < first.distance) {
      first = { distance, position };
    }
    if (!last || distance > last.distance) {
      last = { distance, position };
    }
  }

  return {
    rows,
    columns,
    numSlices: instances.length,
    pixelSpacing,
    orientation,
    firstPosition: first.position,
    lastPosition: last.position,
  };
}

function isClose(a, b, tolerance) {
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

function geometriesMatch(a, b) {
  if (!a || !b) {
    return false;
  }

  if (a.rows !== b.rows || a.columns !== b.columns || a.numSlices !== b.numSlices) {
    return false;
  }

  const spacingMatches = a.pixelSpacing.every(
    (value, index) =>
      Math.abs(value - b.pixelSpacing[index]) <=
      SPACING_RELATIVE_TOLERANCE * Math.max(1, Math.abs(value))
  );
  if (!spacingMatches || !isClose(a.orientation, b.orientation, ORIENTATION_TOLERANCE)) {
    return false;
  }

  // Slice order differs between sources (NIfTI frame order vs. the store's
  // instance order), so compare the two end slices in either order.
  const tolerance = POSITION_TOLERANCE_FRACTION * Math.min(...a.pixelSpacing);
  return (
    (isClose(a.firstPosition, b.firstPosition, tolerance) &&
      isClose(a.lastPosition, b.lastPosition, tolerance)) ||
    (isClose(a.firstPosition, b.lastPosition, tolerance) &&
      isClose(a.lastPosition, b.firstPosition, tolerance))
  );
}

/** "512×512×120" — used to name blank canvases and in import hints. */
function formatGeometry(geometry) {
  return geometry ? `${geometry.columns}×${geometry.rows}×${geometry.numSlices}` : '';
}

/**
 * Every image series in the metadata store that a segmentation could reference,
 * with its grid signature. Blank canvases (synthesized references for
 * segmentations imported without a volume) are included and flagged.
 */
function getReferenceSeriesCandidates() {
  const candidates = [];

  (DicomMetadataStore.getStudyInstanceUIDs() || []).forEach(StudyInstanceUID => {
    const study = DicomMetadataStore.getStudy(StudyInstanceUID);

    (study?.series || []).forEach(series => {
      if (!isImageReferenceSeries(series)) {
        return;
      }

      const firstInstance = series.instances[0];
      const studyDescription =
        firstInstance?.StudyDescription || study.description || StudyInstanceUID;
      const seriesDescription = firstInstance?.SeriesDescription || '';

      candidates.push({
        StudyInstanceUID,
        SeriesInstanceUID: series.SeriesInstanceUID,
        label: seriesDescription ? `${studyDescription} / ${seriesDescription}` : studyDescription,
        lookupName: normalizeLookupName(seriesDescription),
        isBlankCanvas: !!firstInstance?.isBlankSegmentationCanvas,
        geometry: getSeriesGeometry(series),
      });
    });
  });

  return candidates;
}

/**
 * The best reference for a segmentation with `geometry`: real volumes beat
 * blank canvases, then a series named like the segmentation file
 * (case-001 for case-001_seg) wins, then the first match.
 */
function pickMatchingReference(candidates, geometry, segmentationName) {
  const lookupName = segmentationName ? normalizeLookupName(segmentationName) : null;
  const score = candidate =>
    (candidate.isBlankCanvas ? 0 : 2) + (lookupName && candidate.lookupName === lookupName ? 1 : 0);

  return candidates
    .filter(candidate => geometriesMatch(candidate.geometry, geometry))
    .reduce((best, candidate) => (!best || score(candidate) > score(best) ? candidate : best), null);
}

export {
  NON_IMAGE_REFERENCE_MODALITIES,
  isImageReferenceSeries,
  getSlicePosition,
  getParsedVolumeGeometry,
  getSeriesGeometry,
  geometriesMatch,
  formatGeometry,
  getReferenceSeriesCandidates,
  pickMatchingReference,
};
