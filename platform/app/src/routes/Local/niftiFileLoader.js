import * as NiftiReader from 'nifti-reader-js';
import { utilities as csUtilities } from '@cornerstonejs/core';
import {
  cornerstoneNiftiImageLoader,
  init as initNiftiLoader,
  helpers,
} from '@cornerstonejs/nifti-volume-loader';
import * as cornerstone from '@cornerstonejs/core';
import { DicomMetadataStore } from '@ohif/core';

import {
  isImageReferenceSeries,
  getSlicePosition,
  getParsedVolumeGeometry,
  formatGeometry,
  getReferenceSeriesCandidates,
  pickMatchingReference,
} from './segmentationReference';

let niftiLoaderInitialized = false;
const niftiDataStore = new Map();

function initNifti() {
  if (niftiLoaderInitialized) {
    return;
  }

  initNiftiLoader({
    beforeSend: () => ({}),
  });
  niftiLoaderInitialized = true;
}

function generateUID() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000000);
  return `2.25.${timestamp}.${random}`;
}

// NIfTI and NRRD carry no frame of reference, but their affines all place
// voxels in the same scanner world space. Every import that is not linked to a
// DICOM series shares this one, so the viewer treats them as one space.
const NIFTI_FRAME_OF_REFERENCE_UID = generateUID();

// Blank canvases and the segmentations drawn on them live in one study per
// session instead of a study per segmentation.
const SEGMENTATION_WORKSPACE_NAME = 'Imported segmentations';
let segmentationWorkspaceStudyInstanceUID = null;

function rasToLps(rasMatrix) {
  return [
    -rasMatrix[0], -rasMatrix[1], rasMatrix[2],
    -rasMatrix[3], -rasMatrix[4], rasMatrix[5],
    -rasMatrix[6], -rasMatrix[7], rasMatrix[8],
  ];
}

function getArrayConstructor(niftiHeader) {
  const dataTypeCode = niftiHeader.datatypeCode;
  switch (dataTypeCode) {
    case 2:
      return Uint8Array;
    case 4:
      return Int16Array;
    case 8:
      return Int32Array;
    case 16:
      return Float32Array;
    case 64:
      return Float64Array;
    case 256:
      return Int8Array;
    case 512:
      return Uint16Array;
    case 768:
      return Uint32Array;
    default:
      return Float32Array;
  }
}

function extractAffineInfo(niftiHeader) {
  const { qform_code, sform_code } = niftiHeader;

  let affine;

  if (sform_code > 0) {
    affine = [
      [niftiHeader.affine[0][0], niftiHeader.affine[0][1], niftiHeader.affine[0][2], niftiHeader.affine[0][3]],
      [niftiHeader.affine[1][0], niftiHeader.affine[1][1], niftiHeader.affine[1][2], niftiHeader.affine[1][3]],
      [niftiHeader.affine[2][0], niftiHeader.affine[2][1], niftiHeader.affine[2][2], niftiHeader.affine[2][3]],
      [0, 0, 0, 1],
    ];
  } else if (qform_code > 0) {
    affine = niftiHeader.affine;
  } else {
    const pixDim = niftiHeader.pixDims;
    affine = [
      [pixDim[1], 0, 0, 0],
      [0, pixDim[2], 0, 0],
      [0, 0, pixDim[3], 0],
      [0, 0, 0, 1],
    ];
  }

  const spacing = [
    Math.sqrt(affine[0][0] ** 2 + affine[1][0] ** 2 + affine[2][0] ** 2),
    Math.sqrt(affine[0][1] ** 2 + affine[1][1] ** 2 + affine[2][1] ** 2),
    Math.sqrt(affine[0][2] ** 2 + affine[1][2] ** 2 + affine[2][2] ** 2),
  ];

  const direction = [
    affine[0][0] / spacing[0], affine[1][0] / spacing[0], affine[2][0] / spacing[0],
    affine[0][1] / spacing[1], affine[1][1] / spacing[1], affine[2][1] / spacing[1],
    affine[0][2] / spacing[2], affine[1][2] / spacing[2], affine[2][2] / spacing[2],
  ];

  const origin = [affine[0][3], affine[1][3], affine[2][3]];
  const lpsDirection = rasToLps(direction);
  const lpsOrigin = [-origin[0], -origin[1], origin[2]];

  return {
    spacing,
    direction: lpsDirection,
    origin: lpsOrigin,
  };
}

/**
 * Registers an already-parsed volume (scalar data + geometry) with cornerstone:
 * stores its pixel data, builds the per-slice imageIds + metadata, and ensures
 * the shared `nifti:` image loader is registered. Format-agnostic — both the
 * NIfTI loader and the NRRD loader feed their parsed output through here so a
 * registered volume behaves identically regardless of the source file format.
 */
function registerParsedVolume({
  scalarData,
  rows,
  columns,
  numSlices,
  spacing,
  direction,
  origin,
  ArrayConstructor,
}) {
  ensureLoaderRegistered();

  const volumeId = `nifti-local-${generateUID()}`;

  niftiDataStore.set(volumeId, {
    scalarData,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  });

  const imageIds = registerVolumeImageIds({
    volumeId,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  });

  return {
    imageIds,
    volumeId,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  };
}

async function processNiftiFile(file) {
  initNifti();

  let niftiBuffer = await file.arrayBuffer();

  if (NiftiReader.isCompressed(niftiBuffer)) {
    niftiBuffer = NiftiReader.decompress(niftiBuffer);
  }

  if (!NiftiReader.isNIFTI(niftiBuffer)) {
    throw new Error('The provided file is not a valid NIfTI file.');
  }

  const niftiHeader = NiftiReader.readHeader(niftiBuffer);
  const niftiImage = NiftiReader.readImage(niftiHeader, niftiBuffer);

  const dims = niftiHeader.dims;
  const numSlices = dims[3] || 1;
  const rows = dims[2];
  const columns = dims[1];

  const ArrayConstructor = getArrayConstructor(niftiHeader);
  const scalarData = new ArrayConstructor(niftiImage);
  const { spacing, direction, origin } = extractAffineInfo(niftiHeader);

  return registerParsedVolume({
    scalarData,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  });
}

// Large enough for a NIfTI-2 header (540 bytes); NIfTI-1 needs 348.
const NIFTI_HEADER_READ_BYTES = 1024;

/**
 * The first bytes of a (possibly gzipped) NIfTI file, without reading or
 * decompressing the rest of it.
 */
async function readNiftiHead(file) {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;

  if (!isGzip) {
    return file.slice(0, NIFTI_HEADER_READ_BYTES).arrayBuffer();
  }

  if (typeof DecompressionStream === 'undefined') {
    return NiftiReader.decompress(await file.arrayBuffer());
  }

  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const head = new Uint8Array(NIFTI_HEADER_READ_BYTES);
  let length = 0;
  try {
    while (length < head.length) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value.subarray(0, head.length - length);
      head.set(chunk, length);
      length += chunk.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return head.buffer.slice(0, length);
}

/**
 * Grid signature of a NIfTI file read from its header alone, for the import
 * modal to preview which reference a segmentation will get. Null if the header
 * cannot be read.
 */
async function readNiftiFileGeometry(file) {
  try {
    const head = await readNiftiHead(file);

    // Trim to exactly sizeof_hdr so nifti-reader-js does not try to parse
    // header extensions that lie past the bytes we read.
    const view = new DataView(head);
    const littleEndianSize = view.getInt32(0, true);
    const headerSize = littleEndianSize === 348 || littleEndianSize === 540
      ? littleEndianSize
      : view.getInt32(0, false);
    const headerBuffer = head.slice(0, headerSize);

    if (!NiftiReader.isNIFTI(headerBuffer)) {
      return null;
    }

    const niftiHeader = NiftiReader.readHeader(headerBuffer);
    const { spacing, direction, origin } = extractAffineInfo(niftiHeader);

    return getParsedVolumeGeometry({
      rows: niftiHeader.dims[2],
      columns: niftiHeader.dims[1],
      numSlices: niftiHeader.dims[3] || 1,
      spacing,
      direction,
      origin,
    });
  } catch (error) {
    console.warn('Could not read NIfTI header geometry:', error.message);
    return null;
  }
}

/**
 * Builds the per-slice imageIds for a NIfTI volume and registers the cornerstone
 * metadata (image plane / pixel / general series) for each. Shared by the real
 * volume loader (processNiftiFile) and the synthetic blank reference volume so
 * both produce identical, reconstructable geometry.
 */
function registerVolumeImageIds({
  volumeId,
  rows,
  columns,
  numSlices,
  spacing,
  direction,
  origin,
  ArrayConstructor,
  frameOfReferenceUID = NIFTI_FRAME_OF_REFERENCE_UID,
}) {
  const imageIds = [];

  for (let i = 0; i < numSlices; i++) {
    const imageId = `nifti:${volumeId}?frame=${i}`;
    imageIds.push(imageId);

    const imagePositionPatient = getSlicePosition({ origin, direction, spacing }, i);

    const imagePlaneMetadata = {
      frameOfReferenceUID,
      rows,
      columns,
      imageOrientationPatient: [
        direction[0], direction[1], direction[2],
        direction[3], direction[4], direction[5],
      ],
      rowCosines: [direction[0], direction[1], direction[2]],
      columnCosines: [direction[3], direction[4], direction[5]],
      imagePositionPatient,
      sliceThickness: spacing[2],
      sliceLocation: origin[2] + i * spacing[2],
      pixelSpacing: [spacing[0], spacing[1]],
      rowPixelSpacing: spacing[1],
      columnPixelSpacing: spacing[0],
    };

    const imagePixelMetadata = {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      rows,
      columns,
      bitsAllocated: ArrayConstructor.BYTES_PER_ELEMENT * 8,
      bitsStored: ArrayConstructor.BYTES_PER_ELEMENT * 8,
      highBit: ArrayConstructor.BYTES_PER_ELEMENT * 8 - 1,
      pixelRepresentation:
        ArrayConstructor === Uint8Array ||
        ArrayConstructor === Uint16Array ||
        ArrayConstructor === Uint32Array
          ? 0
          : 1,
      planarConfiguration: 0,
      pixelAspectRatio: '1\\1',
    };

    const generalSeriesMetadata = {
      seriesDate: new Date(),
      seriesTime: new Date(),
    };

    csUtilities.genericMetadataProvider.add(imageId, {
      type: 'imagePixelModule',
      metadata: imagePixelMetadata,
    });

    csUtilities.genericMetadataProvider.add(imageId, {
      type: 'imagePlaneModule',
      metadata: imagePlaneMetadata,
    });

    csUtilities.genericMetadataProvider.add(imageId, {
      type: 'generalSeriesModule',
      metadata: generalSeriesMetadata,
    });
  }

  return imageIds;
}

function localNiftiImageLoader(imageId) {
  const [volumeIdWithScheme, frameStr] = imageId.split('?frame=');
  const volumeId = volumeIdWithScheme.replace('nifti:', '');
  const frameIndex = parseInt(frameStr, 10);

  const volumeData = niftiDataStore.get(volumeId);

  if (!volumeData) {
    return {
      promise: Promise.reject(new Error(`NIfTI data not found for volume: ${volumeId}`)),
    };
  }

  const {
    scalarData,
    rows,
    columns,
    spacing,
    ArrayConstructor,
    blank,
  } = volumeData;

  const promise = new Promise(resolve => {
    const numVoxels = rows * columns;

    // A blank canvas (the synthetic reference for a segmentation that
    // was imported without a volume) carries no scalar data, so every slice is
    // an all-zero (black) frame.
    const pixelData = new ArrayConstructor(numVoxels);

    let minPixelValue = 0;
    let maxPixelValue = blank ? 1 : 0;

    if (!blank) {
      const sliceOffset = numVoxels * frameIndex;
      pixelData.set(scalarData.subarray(sliceOffset, sliceOffset + numVoxels));

      minPixelValue = pixelData[0];
      maxPixelValue = pixelData[0];
      for (let i = 1; i < pixelData.length; i++) {
        if (pixelData[i] < minPixelValue) minPixelValue = pixelData[i];
        if (pixelData[i] > maxPixelValue) maxPixelValue = pixelData[i];
      }
    }

    const voxelManager = csUtilities.VoxelManager.createImageVoxelManager({
      width: columns,
      height: rows,
      numberOfComponents: 1,
      scalarData: pixelData,
    });

    resolve({
      imageId,
      dataType: ArrayConstructor.name,
      columnPixelSpacing: spacing[0],
      columns,
      height: rows,
      invert: false,
      rowPixelSpacing: spacing[1],
      rows,
      sizeInBytes: rows * columns * ArrayConstructor.BYTES_PER_ELEMENT,
      width: columns,
      getPixelData: () => voxelManager.getScalarData(),
      getCanvas: undefined,
      numberOfComponents: 1,
      voxelManager,
      minPixelValue,
      maxPixelValue,
    });
  });

  return {
    promise,
    cancelFn: undefined,
    decache: () => {},
  };
}

let loaderRegistered = false;

function ensureLoaderRegistered() {
  if (loaderRegistered) return;

  try {
    cornerstone.imageLoader.registerImageLoader('nifti', localNiftiImageLoader);
    loaderRegistered = true;
  } catch (e) {
    console.warn('NIfTI image loader registration:', e.message);
    loaderRegistered = true;
  }
}

function isNiftiFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.nii') || name.endsWith('.nii.gz');
}

const NIFTI_IMPORT_KINDS = {
  VOLUME: 'volume',
  SEGMENTATION: 'segmentation',
};

function normalizeNiftiImportKind(kind) {
  if (!kind) {
    return NIFTI_IMPORT_KINDS.VOLUME;
  }

  const normalizedKind = String(kind).toLowerCase();

  return normalizedKind === NIFTI_IMPORT_KINDS.SEGMENTATION
    ? NIFTI_IMPORT_KINDS.SEGMENTATION
    : NIFTI_IMPORT_KINDS.VOLUME;
}

function stripNiftiExtension(fileName) {
  return fileName.replace(/\.(nii|nii\.gz)$/i, '');
}

function stripSegmentationSuffix(fileName) {
  return fileName.replace(/([_-](seg|mask|segmentation))$/i, '');
}

function inferReferenceSeriesFromStudy(study, referenceSeriesInstanceUID) {
  if (!study?.series?.length) {
    return null;
  }

  // Only ever accept an image series as a segmentation's reference. If the
  // requested series is itself a SEG, fall through to the first real image
  // series instead of referencing another segmentation.
  if (referenceSeriesInstanceUID) {
    const referencedSeries = study.series.find(
      series => series.SeriesInstanceUID === referenceSeriesInstanceUID
    );

    if (referencedSeries && isImageReferenceSeries(referencedSeries)) {
      return referencedSeries;
    }
  }

  return study.series.find(isImageReferenceSeries) || null;
}

function toReferencedSeriesSequence(series) {
  return {
    SeriesInstanceUID: series.SeriesInstanceUID,
    ReferencedInstanceSequence: series.instances.map(instance => ({
      ReferencedSOPClassUID: instance.SOPClassUID,
      ReferencedSOPInstanceUID: instance.SOPInstanceUID,
    })),
  };
}

function buildReferencedSeriesSequence({
  referenceStudyInstanceUID,
  referenceSeriesInstanceUID,
}) {
  if (!referenceStudyInstanceUID) {
    return null;
  }

  const study = DicomMetadataStore.getStudy(referenceStudyInstanceUID);
  const referencedSeries = inferReferenceSeriesFromStudy(study, referenceSeriesInstanceUID);

  if (!referencedSeries?.instances?.length) {
    return null;
  }

  return toReferencedSeriesSequence(referencedSeries);
}

function getPixelRepresentation(ArrayConstructor) {
  return ArrayConstructor === Uint8Array ||
    ArrayConstructor === Uint16Array ||
    ArrayConstructor === Uint32Array
    ? 0
    : 1;
}

function getSegmentationWorkspaceStudyInstanceUID() {
  // Recreate the study if the metadata store was cleared since it was made.
  if (
    !segmentationWorkspaceStudyInstanceUID ||
    !DicomMetadataStore.getStudy(segmentationWorkspaceStudyInstanceUID)
  ) {
    segmentationWorkspaceStudyInstanceUID = generateUID();
  }
  return segmentationWorkspaceStudyInstanceUID;
}

/**
 * Creates a blank (all-zero) image series with the grid of a segmentation that
 * matched no loaded volume and adds it to the metadata store. A SEG must hang on
 * an image series; later segmentations on the same grid find this canvas
 * through pickMatchingReference and share it, so they render together.
 */
function createBlankCanvas(volume) {
  const { rows, columns, numSlices, spacing, direction, origin, ArrayConstructor } = volume;
  const StudyInstanceUID = getSegmentationWorkspaceStudyInstanceUID();
  const SeriesInstanceUID = generateUID();
  const now = new Date();
  const studyDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const studyTime = now.toTimeString().slice(0, 8).replace(/:/g, '');

  const volumeId = `nifti-blank-${generateUID()}`;

  // No scalarData — localNiftiImageLoader serves zeroed frames for blank volumes.
  niftiDataStore.set(volumeId, {
    blank: true,
    scalarData: null,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  });

  const imageIds = registerVolumeImageIds({
    volumeId,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  });

  const instances = imageIds.map((imageId, index) => ({
    StudyInstanceUID,
    SeriesInstanceUID,
    SOPInstanceUID: generateUID(),
    FrameOfReferenceUID: NIFTI_FRAME_OF_REFERENCE_UID,
    PatientID: 'NIfTI-Patient',
    PatientName: SEGMENTATION_WORKSPACE_NAME,
    StudyDate: studyDate,
    StudyTime: studyTime,
    AccessionNumber: '',
    StudyDescription: SEGMENTATION_WORKSPACE_NAME,
    StudyID: '1',
    SeriesDate: studyDate,
    SeriesTime: studyTime,
    SeriesDescription: `Blank canvas ${formatGeometry(getParsedVolumeGeometry(volume))}`,
    SeriesNumber: 1,
    Modality: 'CT',
    InstanceNumber: index + 1,
    Rows: rows,
    Columns: columns,
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    BitsAllocated: ArrayConstructor.BYTES_PER_ELEMENT * 8,
    BitsStored: ArrayConstructor.BYTES_PER_ELEMENT * 8,
    HighBit: ArrayConstructor.BYTES_PER_ELEMENT * 8 - 1,
    PixelRepresentation: getPixelRepresentation(ArrayConstructor),
    PlanarConfiguration: 0,
    NumberOfFrames: 1,
    ImagePositionPatient: getSlicePosition({ origin, direction, spacing }, index),
    ImageOrientationPatient: [
      direction[0], direction[1], direction[2],
      direction[3], direction[4], direction[5],
    ],
    PixelSpacing: [spacing[0], spacing[1]],
    SliceThickness: spacing[2],
    url: imageId,
    imageId,
    isNifti: true,
    isBlankSegmentationCanvas: true,
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
  }));

  // Add the canvas before the SEG so its display set exists when the SEG
  // resolves its reference (makeDisplaySets runs synchronously on
  // INSTANCES_ADDED).
  DicomMetadataStore.addInstances(instances, true);

  return { StudyInstanceUID, series: { SeriesInstanceUID, instances } };
}

/**
 * The image series a segmentation hangs on: the one the caller linked, else a
 * loaded series (real volume or blank canvas) with the same grid, else a new
 * blank canvas.
 */
function resolveSegmentationReference(volume, displayName, options) {
  if (options.referenceStudyInstanceUID) {
    const study = DicomMetadataStore.getStudy(options.referenceStudyInstanceUID);
    const series = inferReferenceSeriesFromStudy(study, options.referenceSeriesInstanceUID);
    if (series?.instances?.length) {
      return { StudyInstanceUID: options.referenceStudyInstanceUID, series };
    }
  }

  const match = pickMatchingReference(
    getReferenceSeriesCandidates(),
    getParsedVolumeGeometry(volume),
    displayName
  );
  if (match) {
    const series = DicomMetadataStore.getSeries(match.StudyInstanceUID, match.SeriesInstanceUID);
    if (series?.instances?.length) {
      return { StudyInstanceUID: match.StudyInstanceUID, series };
    }
  }

  return createBlankCanvas(volume);
}

/**
 * Builds the synthetic DICOM-like instances for an already-registered volume
 * (see registerParsedVolume) and adds them to the DicomMetadataStore. Shared by
 * the NIfTI and NRRD loaders — `displayName` is the source file name with its
 * format extension already stripped (e.g. "case-001" or "case-001_seg").
 */
async function addRegisteredVolumeToMetadataStore(result, displayName, options = {}) {
  const {
    imageIds,
    rows,
    columns,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  } = result;

  const fileKind = normalizeNiftiImportKind(options.fileKind);
  const isSegmentation = fileKind === NIFTI_IMPORT_KINDS.SEGMENTATION;

  // A segmentation must hang on an image series. Without one the SEG produces
  // no display set and falls through to the unsupported-display-set handler,
  // which makes the thumbnail un-openable ("Unsupported displaySet").
  const reference = isSegmentation
    ? resolveSegmentationReference(result, displayName, options)
    : null;

  const referenceInstance = reference?.series.instances[0];

  const StudyInstanceUID = reference?.StudyInstanceUID || generateUID();
  const referencedStudy = reference ? DicomMetadataStore.getStudy(StudyInstanceUID) : null;
  const SeriesInstanceUID = generateUID();
  const FrameOfReferenceUID =
    referenceInstance?.FrameOfReferenceUID || NIFTI_FRAME_OF_REFERENCE_UID;

  // registerParsedVolume used the shared NIfTI frame of reference; a
  // segmentation drawn on a DICOM series takes that series' one instead.
  if (FrameOfReferenceUID !== NIFTI_FRAME_OF_REFERENCE_UID) {
    registerVolumeImageIds({ ...result, frameOfReferenceUID: FrameOfReferenceUID });
  }

  const fileName = displayName;
  const baseFileName = stripSegmentationSuffix(fileName);
  const now = new Date();
  const studyDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const studyTime = now.toTimeString().slice(0, 8).replace(/:/g, '');

  const referencedSeriesSequence = reference ? toReferencedSeriesSequence(reference.series) : null;
  // A segmentation belongs to its reference's patient, so the viewer does not
  // report "Multiple Patients" for a study the segmentation was added to.
  const PatientID = referenceInstance?.PatientID || 'NIfTI-Patient';
  const PatientName = referenceInstance?.PatientName || fileName;

  const instances = imageIds.map((imageId, index) => {
    const SOPInstanceUID = generateUID();
    const sopClassUID = isSegmentation
      ? '1.2.840.10008.5.1.4.1.1.66.4'
      : '1.2.840.10008.5.1.4.1.1.2';

    const instance = {
      StudyInstanceUID,
      SeriesInstanceUID,
      SOPInstanceUID,
      FrameOfReferenceUID,
      PatientID,
      PatientName,
      StudyDate: studyDate,
      StudyTime: studyTime,
      AccessionNumber: '',
      StudyDescription:
        referencedStudy?.description ||
        referencedStudy?.series?.[0]?.instances?.[0]?.StudyDescription ||
        `NIfTI Import - ${fileName}`,
      StudyID: '1',
      SeriesDate: studyDate,
      SeriesTime: studyTime,
      SeriesDescription: isSegmentation ? `${baseFileName} segmentation` : fileName,
      SeriesNumber: 1,
      Modality: isSegmentation ? 'SEG' : 'CT',
      InstanceNumber: index + 1,
      Rows: rows,
      Columns: columns,
      SamplesPerPixel: 1,
      PhotometricInterpretation: 'MONOCHROME2',
      BitsAllocated: ArrayConstructor.BYTES_PER_ELEMENT * 8,
      BitsStored: ArrayConstructor.BYTES_PER_ELEMENT * 8,
      HighBit: ArrayConstructor.BYTES_PER_ELEMENT * 8 - 1,
      PixelRepresentation: getPixelRepresentation(ArrayConstructor),
      PlanarConfiguration: 0,
      NumberOfFrames: 1,
      ImagePositionPatient: getSlicePosition({ origin, direction, spacing }, index),
      ImageOrientationPatient: [
        direction[0], direction[1], direction[2],
        direction[3], direction[4], direction[5],
      ],
      PixelSpacing: [spacing[0], spacing[1]],
      SliceThickness: spacing[2],
      url: imageId,
      imageId,
      isNifti: true,
      isNiftiSegmentation: isSegmentation,
      isOverlayDisplaySet: isSegmentation,
      SOPClassUID: sopClassUID,
    };

    if (isSegmentation) {
      instance.ReferencedSeriesSequence = referencedSeriesSequence;
      instance.referencedSeriesInstanceUID = reference.series.SeriesInstanceUID;
      instance.referencedDisplaySetInstanceUID = options.referenceDisplaySetInstanceUID || null;
      instance.isDerivedDisplaySet = true;
      if (options.segmentLabels && typeof options.segmentLabels === 'object') {
        instance.segmentLabels = options.segmentLabels;
      }
      if (options.seriesDescription) {
        instance.SeriesDescription = options.seriesDescription;
      }
    }

    return instance;
  });

  // Use addInstances (plural) so DicomMetadataStore fires INSTANCES_ADDED. The
  // mode's defaultRouteInit subscribes to that event to call makeDisplaySets;
  // without it, an in-viewer caller (e.g. the AI panel) adds instances but the
  // SEG display set is never created. The per-instance addInstance loop only
  // happens to work during initial upload because navigation re-triggers the
  // metadata retrieval path.
  DicomMetadataStore.addInstances(instances, true);

  return StudyInstanceUID;
}

async function addNiftiToMetadataStore(file, options = {}) {
  const result = await processNiftiFile(file);
  return addRegisteredVolumeToMetadataStore(result, stripNiftiExtension(file.name), options);
}

export {
  isNiftiFile,
  processNiftiFile,
  registerParsedVolume,
  addRegisteredVolumeToMetadataStore,
  addNiftiToMetadataStore,
  buildReferencedSeriesSequence,
  inferReferenceSeriesFromStudy,
  readNiftiFileGeometry,
  normalizeNiftiImportKind,
  stripSegmentationSuffix,
  stripNiftiExtension,
};
export default { isNiftiFile, processNiftiFile, addNiftiToMetadataStore };