import React from 'react';
import { Button } from '@ohif/ui-next';
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

const processNiftiFile = async (file, type) => {
  try {
    await addNiftiToMetadataStore(file, type);
  } catch (error) {
    console.log('Error when trying to load NIfTI file:', error.message);
  }
};

export default async function filesToStudies(files, dataSource, uiDialogService) {
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

  // Process NIfTI files sequentially to allow for user prompt per file
  for (const file of niftiFiles) {
    let niftiType = 'volume';
    if (uiDialogService) {
      niftiType = await new Promise(resolve => {
        uiDialogService.show({
          id: `nifti-type-${file.name}`,
          title: `Select NIfTI Type for ${file.name}`,
          content: ({ hide }) => {
            return (
              <div className="flex gap-4 p-4 text-white">
                <Button
                  onClick={() => {
                    hide();
                    resolve('volume');
                  }}
                >
                  Volume
                </Button>
                <Button
                  onClick={() => {
                    hide();
                    resolve('segmentation');
                  }}
                >
                  Segmentation
                </Button>
              </div>
            );
          },
        });
      });
    }
    await processNiftiFile(file, niftiType);
  }

  await Promise.all(dicomPromises);

  return DicomMetadataStore.getStudyInstanceUIDs();
}
