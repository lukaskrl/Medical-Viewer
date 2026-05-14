import React, { useEffect, useRef } from 'react';
import classnames from 'classnames';
import { useNavigate } from 'react-router-dom';
import { DicomMetadataStore, MODULE_TYPES, useSystem } from '@ohif/core';

import Dropzone from 'react-dropzone';
import filesToStudies from './filesToStudies';
import { isNiftiFile } from './niftiFileLoader';
import NiftiImportModal from './NiftiImportModal';

import { extensionManager } from '../../App';

import { Button, Icons } from '@ohif/ui-next';

const getLoadButton = (onDrop, text, isDir) => {
  return (
    <Dropzone
      onDrop={onDrop}
      noDrag
    >
      {({ getRootProps, getInputProps }) => (
        <div {...getRootProps()}>
          <Button
            variant="default"
            className="w-28"
            disabled={false}
            onClick={() => {}}
          >
            {text}
            {isDir ? (
              <input
                {...getInputProps()}
                webkitdirectory="true"
                mozdirectory="true"
                style={{ display: 'none' }}
              />
            ) : (
              <input
                {...getInputProps()}
                style={{ display: 'none' }}
              />
            )}
          </Button>
        </div>
      )}
    </Dropzone>
  );
};

type LocalProps = {
  modePath: string;
};

function Local({ modePath }: LocalProps) {
  const { servicesManager } = useSystem();
  const { customizationService } = servicesManager.services;
  const navigate = useNavigate();
  const dropzoneRef = useRef();
  const [dropInitiated, setDropInitiated] = React.useState(false);
  // Files awaiting NIfTI volume/segmentation confirmation in the import modal.
  const [pendingNiftiImport, setPendingNiftiImport] = React.useState<{
    acceptedFiles: File[];
    niftiFiles: File[];
  } | null>(null);

  const LoadingIndicatorProgress = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  );

  // Initializing the dicom local dataSource
  const dataSourceModules = extensionManager.modules[MODULE_TYPES.DATA_SOURCE];
  const localDataSources = dataSourceModules.reduce((acc, curr) => {
    const mods = [];
    curr.module.forEach(mod => {
      if (mod.type === 'localApi') {
        mods.push(mod);
      }
    });
    return acc.concat(mods);
  }, []);

  const firstLocalDataSource = localDataSources[0];
  const dataSource = firstLocalDataSource.createDataSource({});

  const microscopyExtensionLoaded = extensionManager.registeredExtensionIds.includes(
    '@ohif/extension-dicom-microscopy'
  );

  // Existing studies in the metadata store that a segmentation can be linked to.
  const getExistingStudyOptions = () => {
    const studyInstanceUIDs = DicomMetadataStore.getStudyInstanceUIDs() as any[];
    return studyInstanceUIDs.reduce((acc: any[], StudyInstanceUID) => {
      const study = DicomMetadataStore.getStudy(StudyInstanceUID) as any;
      if (!study) {
        return acc;
      }

      const firstSeries = study.series?.[0];
      const description =
        firstSeries?.instances?.[0]?.StudyDescription || study.description || StudyInstanceUID;
      const seriesDescription = firstSeries?.instances?.[0]?.SeriesDescription || '';

      acc.push({
        StudyInstanceUID,
        SeriesInstanceUID: firstSeries?.SeriesInstanceUID,
        label: seriesDescription ? `${description} / ${seriesDescription}` : description,
      });

      return acc;
    }, []);
  };

  const loadStudiesAndNavigate = async (acceptedFiles, niftiOptionsByFile) => {
    setDropInitiated(true);

    const studies = await filesToStudies(acceptedFiles, dataSource, {
      niftiOptionsByFile,
    });

    const query = new URLSearchParams();

    if (microscopyExtensionLoaded) {
      // TODO: for microscopy, we are forcing microscopy mode, which is not ideal.
      //     we should make the local drag and drop navigate to the worklist and
      //     there user can select microscopy mode
      const smStudies = studies.filter(id => {
        const study = DicomMetadataStore.getStudy(id);
        return (
          study.series.findIndex(s => s.Modality === 'SM' || s.instances[0].Modality === 'SM') >= 0
        );
      });

      if (smStudies.length > 0) {
        smStudies.forEach(id => query.append('StudyInstanceUIDs', id));

        modePath = 'microscopy';
      }
    }

    // Todo: navigate to work list and let user select a mode
    studies.forEach(id => query.append('StudyInstanceUIDs', id));
    query.append('datasources', 'dicomlocal');

    navigate(`/${modePath}?${decodeURIComponent(query.toString())}`);
  };

  const onDrop = async acceptedFiles => {
    const niftiFiles = acceptedFiles.filter(isNiftiFile);

    // Let the user confirm volume/segmentation for every NIfTI file at once.
    if (niftiFiles.length > 0) {
      setPendingNiftiImport({ acceptedFiles, niftiFiles });
      return;
    }

    await loadStudiesAndNavigate(acceptedFiles, null);
  };

  const handleNiftiConfirm = resolution => {
    const pending = pendingNiftiImport;
    setPendingNiftiImport(null);
    if (pending) {
      loadStudiesAndNavigate(pending.acceptedFiles, resolution);
    }
  };

  const handleNiftiCancel = () => {
    setPendingNiftiImport(null);
    setDropInitiated(false);
  };

  // Set body style
  useEffect(() => {
    document.body.classList.add('bg-background');
    return () => {
      document.body.classList.remove('bg-background');
    };
  }, []);

  return (
    <Dropzone
      ref={dropzoneRef}
      onDrop={onDrop}
      noClick
    >
      {({ getRootProps }) => (
        <div
          {...getRootProps()}
          style={{ width: '100%', height: '100%' }}
        >
          {pendingNiftiImport && (
            <NiftiImportModal
              files={pendingNiftiImport.niftiFiles}
              studies={getExistingStudyOptions()}
              onConfirm={handleNiftiConfirm}
              onCancel={handleNiftiCancel}
            />
          )}
          <div className="flex h-screen w-screen items-center justify-center">
            <div className="bg-muted border-primary/60 mx-auto space-y-2 rounded-xl border border-dashed py-12 px-12 drop-shadow-md">
              <div className="flex items-center justify-center">
                <Icons.OHIFLogoColorDarkBackground className="h-18" />
              </div>
              <div className="space-y-2 py-6 text-center">
                {dropInitiated ? (
                  <div className="flex flex-col items-center justify-center pt-12">
                    <LoadingIndicatorProgress className={'h-full w-full bg-background'} />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-primary pt-0 text-xl">
                      Drag and drop your DICOM or NIfTI files & folders here <br />
                      to load them locally.
                    </p>
                    <p className="text-muted-foreground text-base">
                      Supported formats: DICOM (.dcm), NIfTI (.nii, .nii.gz)
                      <br />
                      Note: Your data remains locally within your browser
                      <br /> and is never uploaded to any server.
                    </p>
                  </div>
                )}
              </div>
              <div className="flex justify-center gap-2 pt-4">
                {getLoadButton(onDrop, 'Load files', false)}
                {getLoadButton(onDrop, 'Load folders', true)}
              </div>
            </div>
          </div>
        </div>
      )}
    </Dropzone>
  );
}

export default Local;
