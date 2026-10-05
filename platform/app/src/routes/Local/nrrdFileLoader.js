import {
  registerParsedVolume,
  addRegisteredVolumeToMetadataStore,
} from './niftiFileLoader';
import { parseNrrd, parseNrrdGeometry } from './nrrdParser';
import { getParsedVolumeGeometry } from './segmentationReference';

/**
 * NRRD local-file loader. Parses `.nrrd` / `.seg.nrrd` files and feeds the
 * result through the same volume-registration + metadata-store machinery the
 * NIfTI loader uses, so NRRD volumes and segmentations render through the
 * identical cornerstone pipeline.
 */

function isNrrdFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.nrrd') || name.endsWith('.nhdr');
}

// Strip the NRRD extension. A 3D Slicer ".seg.nrrd" collapses to the same base
// name as its matching ".nrrd" volume so the import modal can pair them.
function stripNrrdExtension(fileName) {
  return fileName.replace(/\.(seg\.nrrd|nrrd|nhdr)$/i, '');
}

/**
 * Build a { [labelValue]: name } map from a 3D Slicer ".seg.nrrd" segment table
 * (Segment0_Name / Segment0_LabelValue key/value pairs). Returns null when the
 * file carries no segment metadata so segments fall back to "Segment N".
 */
function parseNrrdSegmentLabels(keyValuePairs) {
  if (!keyValuePairs) {
    return null;
  }

  const labels = {};
  Object.keys(keyValuePairs).forEach(key => {
    const match = key.match(/^Segment(\d+)_Name$/i);
    if (!match) {
      return;
    }

    const index = match[1];
    const name = keyValuePairs[key];
    const rawLabelValue = keyValuePairs[`Segment${index}_LabelValue`];
    const labelValue = rawLabelValue != null ? parseInt(rawLabelValue, 10) : NaN;

    if (Number.isFinite(labelValue) && name) {
      labels[labelValue] = name;
    }
  });

  return Object.keys(labels).length ? labels : null;
}

// NRRD headers are plain text before the data; Slicer segment tables can make
// them a few tens of KB.
const NRRD_HEADER_READ_BYTES = 256 * 1024;

/**
 * Grid signature of a NRRD file read from its header alone, for the import
 * modal to preview which reference a segmentation will get. Null if the header
 * cannot be read.
 */
async function readNrrdFileGeometry(file) {
  try {
    const head = await file.slice(0, NRRD_HEADER_READ_BYTES).arrayBuffer();
    return getParsedVolumeGeometry(parseNrrdGeometry(head));
  } catch (error) {
    console.warn('Could not read NRRD header geometry:', error.message);
    return null;
  }
}

async function addNrrdToMetadataStore(file, options = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const parsed = parseNrrd(arrayBuffer);

  const result = registerParsedVolume({
    scalarData: parsed.scalarData,
    rows: parsed.rows,
    columns: parsed.columns,
    numSlices: parsed.numSlices,
    spacing: parsed.spacing,
    direction: parsed.direction,
    origin: parsed.origin,
    ArrayConstructor: parsed.ArrayConstructor,
  });

  const fileOptions = { ...options };

  // Auto-derive segment names from a Slicer ".seg.nrrd" segment table unless the
  // caller already supplied explicit labels.
  if (!fileOptions.segmentLabels) {
    const segmentLabels = parseNrrdSegmentLabels(parsed.keyValuePairs);
    if (segmentLabels) {
      fileOptions.segmentLabels = segmentLabels;
    }
  }

  return addRegisteredVolumeToMetadataStore(result, stripNrrdExtension(file.name), fileOptions);
}

export {
  isNrrdFile,
  stripNrrdExtension,
  parseNrrdSegmentLabels,
  readNrrdFileGeometry,
  addNrrdToMetadataStore,
};
export default { isNrrdFile, addNrrdToMetadataStore };
