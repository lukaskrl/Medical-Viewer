import FileLoaderService from './fileLoaderService';
import { DicomMetadataStore } from '@ohif/core';
import { isNiftiFile, addNiftiToMetadataStore } from './niftiFileLoader';

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

const processNiftiFile = async file => {
  try {
    await addNiftiToMetadataStore(file);
  } catch (error) {
    console.log('Error when trying to load NIfTI file:', error.message);
  }
};

export default async function filesToStudies(files) {
  // Separate NIfTI files from DICOM/other files
  const niftiFiles = [];
  const otherFiles = [];

  files.forEach(file => {
    if (isNiftiFile(file)) {
      niftiFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  });

  // Process DICOM files
  const dicomPromises = otherFiles.map(processFile);

  // Process NIfTI files
  const niftiPromises = niftiFiles.map(processNiftiFile);

  await Promise.all([...dicomPromises, ...niftiPromises]);

  return DicomMetadataStore.getStudyInstanceUIDs();
}
