import * as NiftiReader from 'nifti-reader-js';
import { utilities as csUtilities } from '@cornerstonejs/core';
import {
  cornerstoneNiftiImageLoader,
  init as initNiftiLoader,
  helpers,
} from '@cornerstonejs/nifti-volume-loader';
import * as cornerstone from '@cornerstonejs/core';
import { DicomMetadataStore } from '@ohif/core';

// Initialize the NIfTI loader
let niftiLoaderInitialized = false;

// Store the nifti data for the image loader to access
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

/**
 * Generate a unique UID similar to DICOM UIDs
 */
function generateUID() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000000);
  return `2.25.${timestamp}.${random}`;
}

/**
 * Convert RAS orientation (NIfTI) to LPS orientation (DICOM)
 */
function rasToLps(rasMatrix) {
  // RAS to LPS conversion: flip X and Y
  return [
    -rasMatrix[0], -rasMatrix[1], rasMatrix[2],
    -rasMatrix[3], -rasMatrix[4], rasMatrix[5],
    -rasMatrix[6], -rasMatrix[7], rasMatrix[8],
  ];
}

/**
 * Get the appropriate TypedArray constructor based on NIfTI data type
 */
function getArrayConstructor(niftiHeader) {
  const dataTypeCode = niftiHeader.datatypeCode;
  switch (dataTypeCode) {
    case 2: // UINT8
      return Uint8Array;
    case 4: // INT16
      return Int16Array;
    case 8: // INT32
      return Int32Array;
    case 16: // FLOAT32
      return Float32Array;
    case 64: // FLOAT64
      return Float64Array;
    case 256: // INT8
      return Int8Array;
    case 512: // UINT16
      return Uint16Array;
    case 768: // UINT32
      return Uint32Array;
    default:
      return Float32Array;
  }
}

/**
 * Extract affine matrix information from NIfTI header
 */
function extractAffineInfo(niftiHeader) {
  const { qform_code, sform_code } = niftiHeader;

  let affine;

  // Prefer sform if available, otherwise use qform
  if (sform_code > 0) {
    affine = [
      [niftiHeader.affine[0][0], niftiHeader.affine[0][1], niftiHeader.affine[0][2], niftiHeader.affine[0][3]],
      [niftiHeader.affine[1][0], niftiHeader.affine[1][1], niftiHeader.affine[1][2], niftiHeader.affine[1][3]],
      [niftiHeader.affine[2][0], niftiHeader.affine[2][1], niftiHeader.affine[2][2], niftiHeader.affine[2][3]],
      [0, 0, 0, 1],
    ];
  } else if (qform_code > 0) {
    // Use quaternion-based transformation
    affine = niftiHeader.affine;
  } else {
    // Use pixdim as spacing with identity rotation
    const pixDim = niftiHeader.pixDims;
    affine = [
      [pixDim[1], 0, 0, 0],
      [0, pixDim[2], 0, 0],
      [0, 0, pixDim[3], 0],
      [0, 0, 0, 1],
    ];
  }

  // Extract direction cosines and spacing from affine
  const spacing = [
    Math.sqrt(affine[0][0] ** 2 + affine[1][0] ** 2 + affine[2][0] ** 2),
    Math.sqrt(affine[0][1] ** 2 + affine[1][1] ** 2 + affine[2][1] ** 2),
    Math.sqrt(affine[0][2] ** 2 + affine[1][2] ** 2 + affine[2][2] ** 2),
  ];

  // Normalize to get direction cosines
  const direction = [
    affine[0][0] / spacing[0], affine[1][0] / spacing[0], affine[2][0] / spacing[0],
    affine[0][1] / spacing[1], affine[1][1] / spacing[1], affine[2][1] / spacing[1],
    affine[0][2] / spacing[2], affine[1][2] / spacing[2], affine[2][2] / spacing[2],
  ];

  // Origin is the last column of the affine (translation)
  const origin = [affine[0][3], affine[1][3], affine[2][3]];

  // Convert from RAS to LPS
  const lpsDirection = rasToLps(direction);
  const lpsOrigin = [-origin[0], -origin[1], origin[2]];

  return {
    spacing,
    direction: lpsDirection,
    origin: lpsOrigin,
  };
}

/**
 * Process NIfTI file and create image IDs with cached metadata
 */
async function processNiftiFile(file) {
  initNifti();

  // Read file as ArrayBuffer
  let niftiBuffer = await file.arrayBuffer();

  // Check if compressed and decompress if necessary
  if (NiftiReader.isCompressed(niftiBuffer)) {
    niftiBuffer = NiftiReader.decompress(niftiBuffer);
  }

  // Validate it's a NIfTI file
  if (!NiftiReader.isNIFTI(niftiBuffer)) {
    throw new Error('The provided file is not a valid NIfTI file.');
  }

  // Read the NIfTI header and image data
  const niftiHeader = NiftiReader.readHeader(niftiBuffer);
  const niftiImage = NiftiReader.readImage(niftiHeader, niftiBuffer);

  // Get dimensions
  const dims = niftiHeader.dims;
  const numSlices = dims[3] || 1;
  const rows = dims[2];
  const columns = dims[1];

  // Get array constructor based on data type
  const ArrayConstructor = getArrayConstructor(niftiHeader);

  // Create typed array from image data
  const scalarData = new ArrayConstructor(niftiImage);

  // Extract affine transformation info
  const { spacing, direction, origin } = extractAffineInfo(niftiHeader);

  // Generate unique ID for this NIfTI volume
  const volumeId = `nifti-local-${generateUID()}`;

  // Store the scalar data for the custom image loader
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

  // Create image IDs and register metadata
  const imageIds = [];

  for (let i = 0; i < numSlices; i++) {
    const imageId = `nifti:${volumeId}?frame=${i}`;
    imageIds.push(imageId);

    // Calculate image position for this slice
    const imagePositionPatient = [
      origin[0] + i * direction[6] * spacing[2],
      origin[1] + i * direction[7] * spacing[2],
      origin[2] + i * direction[8] * spacing[2],
    ];

    // Image plane metadata
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

    // Image pixel metadata
    const imagePixelMetadata = {
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      rows,
      columns,
      bitsAllocated: ArrayConstructor.BYTES_PER_ELEMENT * 8,
      bitsStored: ArrayConstructor.BYTES_PER_ELEMENT * 8,
      highBit: ArrayConstructor.BYTES_PER_ELEMENT * 8 - 1,
      pixelRepresentation: ArrayConstructor === Uint8Array || ArrayConstructor === Uint16Array || ArrayConstructor === Uint32Array ? 0 : 1,
      planarConfiguration: 0,
      pixelAspectRatio: '1\\1',
    };

    // General series metadata
    const generalSeriesMetadata = {
      seriesDate: new Date(),
      seriesTime: new Date(),
    };

    // Register metadata with cornerstone
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

  // Register custom image loader for this volume
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
  };
}

/**
 * Custom image loader for local NIfTI files
 */
function registerNiftiImageLoader(volumeId) {
  // The loader is registered globally, so we just need to ensure
  // the data is available in our store
}

/**
 * Custom image loader function for NIfTI images
 */
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

  const { scalarData, rows, columns, numSlices, spacing, direction, origin, ArrayConstructor } = volumeData;

  const promise = new Promise((resolve) => {
    const numVoxels = rows * columns;
    const sliceOffset = numVoxels * frameIndex;

    // Extract slice data
    const pixelData = new ArrayConstructor(numVoxels);
    pixelData.set(scalarData.subarray(sliceOffset, sliceOffset + numVoxels));

    // Calculate min/max pixel values
    let minPixelValue = pixelData[0];
    let maxPixelValue = pixelData[0];
    for (let i = 1; i < pixelData.length; i++) {
      if (pixelData[i] < minPixelValue) minPixelValue = pixelData[i];
      if (pixelData[i] > maxPixelValue) maxPixelValue = pixelData[i];
    }

    // Create voxel manager
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
    decache: () => {
      // Optionally clean up data
    },
  };
}

// Register our custom loader for NIfTI images
// This will be called during initialization
let loaderRegistered = false;

function ensureLoaderRegistered() {
  if (loaderRegistered) return;

  try {
    cornerstone.imageLoader.registerImageLoader('nifti', localNiftiImageLoader);
    loaderRegistered = true;
  } catch (e) {
    // Loader might already be registered
    console.warn('NIfTI image loader registration:', e.message);
    loaderRegistered = true;
  }
}

/**
 * Check if a file is a NIfTI file based on extension
 */
function isNiftiFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.nii') || name.endsWith('.nii.gz');
}

/**
 * Add NIfTI volume to the DicomMetadataStore as synthetic DICOM data
 */
async function addNiftiToMetadataStore(file) {
  // Ensure loader is registered
  ensureLoaderRegistered();

  // Process the NIfTI file
  const result = await processNiftiFile(file);
  const { imageIds, rows, columns, numSlices, spacing, direction, origin } = result;

  // Generate synthetic DICOM UIDs
  const StudyInstanceUID = generateUID();
  const SeriesInstanceUID = generateUID();
  const FrameOfReferenceUID = generateUID();

  // Extract filename for descriptions
  const fileName = file.name.replace(/\.(nii|nii\.gz)$/i, '');
  const now = new Date();
  const studyDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const studyTime = now.toTimeString().slice(0, 8).replace(/:/g, '');

  // Create synthetic instances for each slice
  const instances = imageIds.map((imageId, index) => {
    const SOPInstanceUID = generateUID();

    // Calculate image position for this slice
    const ImagePositionPatient = [
      origin[0] + index * direction[6] * spacing[2],
      origin[1] + index * direction[7] * spacing[2],
      origin[2] + index * direction[8] * spacing[2],
    ];

    return {
      // Core identification
      StudyInstanceUID,
      SeriesInstanceUID,
      SOPInstanceUID,
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', // CT Image Storage
      FrameOfReferenceUID,

      // Patient info
      PatientID: 'NIfTI-Patient',
      PatientName: fileName,

      // Study info
      StudyDate: studyDate,
      StudyTime: studyTime,
      AccessionNumber: '',
      StudyDescription: `NIfTI Import - ${fileName}`,
      StudyID: '1',

      // Series info
      SeriesDate: studyDate,
      SeriesTime: studyTime,
      SeriesDescription: fileName,
      SeriesNumber: 1,
      Modality: 'OT',

      // Instance info
      InstanceNumber: index + 1,

      // Image properties
      Rows: rows,
      Columns: columns,
      NumberOfFrames: 1,
      ImagePositionPatient,
      ImageOrientationPatient: [
        direction[0], direction[1], direction[2],
        direction[3], direction[4], direction[5],
      ],
      PixelSpacing: [spacing[0], spacing[1]],
      SliceThickness: spacing[2],

      // Reference to the actual image data
      url: imageId,
      imageId: imageId,

      // Flag this as NIfTI-derived
      isNifti: true,
    };
  });

  // Add each instance to the metadata store
  for (const instance of instances) {
    DicomMetadataStore.addInstance(instance);
  }

  return StudyInstanceUID;
}

export { isNiftiFile, processNiftiFile, addNiftiToMetadataStore };
export default { isNiftiFile, processNiftiFile, addNiftiToMetadataStore };
