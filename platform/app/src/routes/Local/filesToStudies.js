import FileLoaderService from './fileLoaderService';
import { DicomMetadataStore } from '@ohif/core';
import { isNiftiFile, addNiftiToMetadataStore } from './niftiFileLoader';
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

const processNiftiFile = async (file, niftiOptions) => {
  try {
    return await addNiftiToMetadataStore(file, niftiOptions);
  } catch (error) {
    console.log('Error when trying to load NIfTI file:', error.message);
    return null;
  }
};

export default async function filesToStudies(files, _dataSource, options = {}) {
  const niftiFiles = [];
  const otherFiles = [];

  files.forEach(file => {
    if (isNiftiFile(file)) {
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
    const studyInstanceUID = await processNiftiFile(file, getOptions(file));
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

    await processNiftiFile(file, fileOptions);
  }

  return DicomMetadataStore.getStudyInstanceUIDs();
}
