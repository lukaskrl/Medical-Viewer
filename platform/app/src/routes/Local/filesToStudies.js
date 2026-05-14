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
    await addNiftiToMetadataStore(file, niftiOptions);
  } catch (error) {
    console.log('Error when trying to load NIfTI file:', error.message);
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
  const niftiOptionsResolver = options?.resolveNiftiOptions;

  const niftiVolumeFiles = [];
  const niftiSegmentationFiles = [];

  niftiFiles.forEach(file => {
    const inferredKind = inferNiftiImportKind(file.name);
    if (inferredKind === NIFTI_IMPORT_KINDS.SEGMENTATION) {
      niftiSegmentationFiles.push(file);
      return;
    }

    niftiVolumeFiles.push(file);
  });

  const orderedNiftiFiles = [...niftiVolumeFiles, ...niftiSegmentationFiles];

  await Promise.all(dicomPromises);

  for (const file of orderedNiftiFiles) {
    const niftiOptions = niftiOptionsResolver ? await niftiOptionsResolver(file) : undefined;
    await processNiftiFile(file, niftiOptions);
  }

  return DicomMetadataStore.getStudyInstanceUIDs();
}
