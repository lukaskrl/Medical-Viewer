import FileLoaderService from './fileLoaderService';
import { DicomMetadataStore } from '@ohif/core';
import { isNiftiFile, addNiftiToMetadataStore } from './niftiFileLoader';
import { isNrrdFile, addNrrdToMetadataStore } from './nrrdFileLoader';
import { inferNiftiImportKind, NIFTI_IMPORT_KINDS } from './niftiUploadOptions';

const processFile = async file => {
  try {
    const fileLoaderService = new FileLoaderService(file);
    const imageId = fileLoaderService.addFile(file);
    const image = await fileLoaderService.loadFile(file, imageId);
    const dicomJSONDataset = await fileLoaderService.getDataset(image, imageId);

    DicomMetadataStore.addInstance(dicomJSONDataset);
  } catch (error) {
    console.log(error.name, ':Error when trying to load and process local files:', error.message);
  }
};

// Route a NIfTI or NRRD file to its loader. Both produce synthetic DICOM-like
// instances in the metadata store and return the StudyInstanceUID they created.
const processVolumeFile = async (file, importOptions) => {
  try {
    if (isNrrdFile(file)) {
      return await addNrrdToMetadataStore(file, importOptions);
    }
    return await addNiftiToMetadataStore(file, importOptions);
  } catch (error) {
    console.log('Error when trying to load NIfTI/NRRD file:', error.message);
    return null;
  }
};

export default async function filesToStudies(files, _dataSource, options = {}) {
  const niftiFiles = [];
  const otherFiles = [];

  files.forEach(file => {
    if (isNiftiFile(file) || isNrrdFile(file)) {
      niftiFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  });

  const dicomPromises = otherFiles.map(processFile);
  await Promise.all(dicomPromises);

  // Per-file NIfTI import options gathered up front (e.g. from the import
  // confirmation modal). Falls back to inferring from the file name.
  const niftiOptionsByFile =
    options?.niftiOptionsByFile instanceof Map ? options.niftiOptionsByFile : null;

  const getOptions = file => {
    const resolved = niftiOptionsByFile?.get(file);
    if (resolved) {
      return resolved;
    }
    return { fileKind: inferNiftiImportKind(file.name) };
  };

  const niftiVolumeFiles = [];
  const niftiSegmentationFiles = [];

  niftiFiles.forEach(file => {
    if (getOptions(file).fileKind === NIFTI_IMPORT_KINDS.SEGMENTATION) {
      niftiSegmentationFiles.push(file);
    } else {
      niftiVolumeFiles.push(file);
    }
  });

  // Volumes first so segmentations can reference a volume from the same batch.
  const volumeInfoByFileName = new Map();
  for (const file of niftiVolumeFiles) {
    const studyInstanceUID = await processVolumeFile(file, getOptions(file));
    if (studyInstanceUID) {
      const study = DicomMetadataStore.getStudy(studyInstanceUID);
      volumeInfoByFileName.set(file.name, {
        studyInstanceUID,
        seriesInstanceUID: study?.series?.[0]?.SeriesInstanceUID,
      });
    }
  }

  for (const file of niftiSegmentationFiles) {
    const fileOptions = { ...getOptions(file) };

    // Resolve a same-batch volume reference to the study/series it produced.
    if (!fileOptions.referenceStudyInstanceUID && fileOptions.referenceFileName) {
      const volumeInfo = volumeInfoByFileName.get(fileOptions.referenceFileName);
      if (volumeInfo) {
        fileOptions.referenceStudyInstanceUID = volumeInfo.studyInstanceUID;
        fileOptions.referenceSeriesInstanceUID =
          fileOptions.referenceSeriesInstanceUID || volumeInfo.seriesInstanceUID;
      }
    }

    await processVolumeFile(file, fileOptions);
  }

  return DicomMetadataStore.getStudyInstanceUIDs();
}
