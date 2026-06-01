import * as NiftiReader from 'nifti-reader-js';
import { utilities as csUtilities } from '@cornerstonejs/core';
import {
  cornerstoneNiftiImageLoader,
  init as initNiftiLoader,
  helpers,
} from '@cornerstonejs/nifti-volume-loader';
import * as cornerstone from '@cornerstonejs/core';
import { DicomMetadataStore } from '@ohif/core';

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

  const volumeId = `nifti-local-${generateUID()}`;

  niftiDataStore.set(volumeId, {
    scalarData,
    niftiHeader,
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

  registerNiftiImageLoader(volumeId);

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
}) {
  const imageIds = [];

  for (let i = 0; i < numSlices; i++) {
    const imageId = `nifti:${volumeId}?frame=${i}`;
    imageIds.push(imageId);

    const imagePositionPatient = [
      origin[0] + i * direction[6] * spacing[2],
      origin[1] + i * direction[7] * spacing[2],
      origin[2] + i * direction[8] * spacing[2],
    ];

    const imagePlaneMetadata = {
      frameOfReferenceUID: '1.2.840.10008.1.4',
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

function registerNiftiImageLoader(volumeId) {
  if (!niftiDataStore.has(volumeId)) {
    return;
  }
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

    // A blank companion volume (the synthetic reference for a segmentation that
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

  if (referenceSeriesInstanceUID) {
    const referencedSeries = study.series.find(
      series => series.SeriesInstanceUID === referenceSeriesInstanceUID
    );

    if (referencedSeries) {
      return referencedSeries;
    }
  }

  return study.series[0];
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

  return {
    SeriesInstanceUID: referencedSeries.SeriesInstanceUID,
    ReferencedInstanceSequence: referencedSeries.instances.map(instance => ({
      ReferencedSOPClassUID: instance.SOPClassUID,
      ReferencedSOPInstanceUID: instance.SOPInstanceUID,
    })),
  };
}

/**
 * Creates a blank (all-zero) reference volume that matches the geometry of a
 * segmentation. A SEG must hang on a volume — when a segmentation is imported
 * without one, this synthesizes the missing volume from the seg's own geometry
 * so the labelmap has something to render against. Returns the new series UID
 * and its instances (a CT-modality image series); the caller is responsible for
 * adding the instances to the DicomMetadataStore.
 */
function createBlankReferenceVolume(geometry, meta) {
  const { rows, columns, numSlices, spacing, direction, origin, ArrayConstructor } = geometry;
  const {
    StudyInstanceUID,
    SeriesInstanceUID,
    FrameOfReferenceUID,
    studyDate,
    studyTime,
    patientName,
    studyDescription,
    seriesDescription,
  } = meta;

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

  const pixelRepresentation =
    ArrayConstructor === Uint8Array ||
    ArrayConstructor === Uint16Array ||
    ArrayConstructor === Uint32Array
      ? 0
      : 1;

  const instances = imageIds.map((imageId, index) => {
    const SOPInstanceUID = generateUID();
    const ImagePositionPatient = [
      origin[0] + index * direction[6] * spacing[2],
      origin[1] + index * direction[7] * spacing[2],
      origin[2] + index * direction[8] * spacing[2],
    ];

    return {
      StudyInstanceUID,
      SeriesInstanceUID,
      SOPInstanceUID,
      FrameOfReferenceUID,
      PatientID: 'NIfTI-Patient',
      PatientName: patientName,
      StudyDate: studyDate,
      StudyTime: studyTime,
      AccessionNumber: '',
      StudyDescription: studyDescription,
      StudyID: '1',
      SeriesDate: studyDate,
      SeriesTime: studyTime,
      SeriesDescription: seriesDescription,
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
      PixelRepresentation: pixelRepresentation,
      PlanarConfiguration: 0,
      NumberOfFrames: 1,
      ImagePositionPatient,
      ImageOrientationPatient: [
        direction[0], direction[1], direction[2],
        direction[3], direction[4], direction[5],
      ],
      PixelSpacing: [spacing[0], spacing[1]],
      SliceThickness: spacing[2],
      url: imageId,
      imageId,
      isNifti: true,
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    };
  });

  return { SeriesInstanceUID, instances };
}

async function addNiftiToMetadataStore(file, options = {}) {
  ensureLoaderRegistered();

  const result = await processNiftiFile(file);
  const {
    imageIds,
    rows,
    columns,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
  } = result;

  const fileKind = normalizeNiftiImportKind(options.fileKind);
  const isSegmentation = fileKind === NIFTI_IMPORT_KINDS.SEGMENTATION;

  const referencedStudy =
    isSegmentation && options.referenceStudyInstanceUID
      ? DicomMetadataStore.getStudy(options.referenceStudyInstanceUID)
      : null;
  const referencedSeries =
    isSegmentation && options.referenceSeriesInstanceUID
      ? inferReferenceSeriesFromStudy(referencedStudy, options.referenceSeriesInstanceUID)
      : null;

  const StudyInstanceUID = referencedStudy?.StudyInstanceUID || generateUID();
  const SeriesInstanceUID = generateUID();
  const FrameOfReferenceUID =
    referencedSeries?.instances?.[0]?.FrameOfReferenceUID || generateUID();

  const fileName = stripNiftiExtension(file.name);
  const baseFileName = stripSegmentationSuffix(fileName);
  const now = new Date();
  const studyDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const studyTime = now.toTimeString().slice(0, 8).replace(/:/g, '');

  let referencedSeriesSequence = isSegmentation ? buildReferencedSeriesSequence(options) : null;
  let effectiveReferenceSeriesInstanceUID = options.referenceSeriesInstanceUID || null;

  // A segmentation must hang on a volume. When it is imported without a
  // resolvable reference (e.g. "No reference" in the import modal, or a link
  // that no longer matches a loaded study), synthesize a blank companion volume
  // from the seg's own geometry and reference it. Without this the SEG produces
  // no display set and falls through to the unsupported-display-set handler,
  // which makes the thumbnail un-openable ("Unsupported displaySet").
  if (isSegmentation && !referencedSeriesSequence) {
    const companionSeriesInstanceUID = generateUID();
    const { instances: companionInstances } = createBlankReferenceVolume(result, {
      StudyInstanceUID,
      SeriesInstanceUID: companionSeriesInstanceUID,
      FrameOfReferenceUID,
      studyDate,
      studyTime,
      patientName: fileName,
      studyDescription: `NIfTI Import - ${fileName}`,
      seriesDescription: `${baseFileName} reference`,
    });

    // Add the companion first so its display set exists when the SEG resolves
    // its reference (makeDisplaySets runs synchronously on INSTANCES_ADDED).
    DicomMetadataStore.addInstances(companionInstances, true);

    referencedSeriesSequence = {
      SeriesInstanceUID: companionSeriesInstanceUID,
      ReferencedInstanceSequence: companionInstances.map(companionInstance => ({
        ReferencedSOPClassUID: companionInstance.SOPClassUID,
        ReferencedSOPInstanceUID: companionInstance.SOPInstanceUID,
      })),
    };
    effectiveReferenceSeriesInstanceUID = companionSeriesInstanceUID;
  }

  const instances = imageIds.map((imageId, index) => {
    const SOPInstanceUID = generateUID();
    const sopClassUID = isSegmentation
      ? '1.2.840.10008.5.1.4.1.1.66.4'
      : '1.2.840.10008.5.1.4.1.1.2';

    const ImagePositionPatient = [
      origin[0] + index * direction[6] * spacing[2],
      origin[1] + index * direction[7] * spacing[2],
      origin[2] + index * direction[8] * spacing[2],
    ];

    const instance = {
      StudyInstanceUID,
      SeriesInstanceUID,
      SOPInstanceUID,
      FrameOfReferenceUID,
      PatientID: 'NIfTI-Patient',
      PatientName: fileName,
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
      PixelRepresentation:
        ArrayConstructor === Uint8Array ||
        ArrayConstructor === Uint16Array ||
        ArrayConstructor === Uint32Array
          ? 0
          : 1,
      PlanarConfiguration: 0,
      NumberOfFrames: 1,
      ImagePositionPatient,
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
      instance.referencedSeriesInstanceUID = effectiveReferenceSeriesInstanceUID;
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

export {
  isNiftiFile,
  processNiftiFile,
  addNiftiToMetadataStore,
  buildReferencedSeriesSequence,
  normalizeNiftiImportKind,
  stripSegmentationSuffix,
  stripNiftiExtension,
};
export default { isNiftiFile, processNiftiFile, addNiftiToMetadataStore };