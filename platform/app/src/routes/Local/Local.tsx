import React, { useEffect, useRef } from 'react';
import classnames from 'classnames';
import { useNavigate } from 'react-router-dom';
import { DicomMetadataStore, MODULE_TYPES, useSystem } from '@ohif/core';

import Dropzone from 'react-dropzone';
import filesToStudies from './filesToStudies';
import {
  findMatchingStudyForNifti,
  inferNiftiImportKind,
  NIFTI_IMPORT_KINDS,
} from './niftiUploadOptions';

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

  const resolveNiftiOptions = async file => {
    const inferredKind = inferNiftiImportKind(file.name);
    const defaultKind = inferredKind;
    const kindAnswer = window.prompt(
      `${file.name}\nEnter volume or segmentation for this NIfTI file.`,
      defaultKind
    );
    const fileKind =
      kindAnswer?.toLowerCase() === NIFTI_IMPORT_KINDS.SEGMENTATION
        ? NIFTI_IMPORT_KINDS.SEGMENTATION
        : NIFTI_IMPORT_KINDS.VOLUME;

    if (fileKind !== NIFTI_IMPORT_KINDS.SEGMENTATION) {
      return { fileKind };
    }

    const studyInstanceUIDs = DicomMetadataStore.getStudyInstanceUIDs() as any[];
    const studies: any[] = studyInstanceUIDs.reduce((acc: any[], StudyInstanceUID) => {
        const study = DicomMetadataStore.getStudy(StudyInstanceUID) as any;
        if (!study) {
          return acc;
        }

        acc.push({
          StudyInstanceUID,
          description: study.description || '',
          series: study.series || [],
        });

        return acc;
      }, []);

    const inferredStudy = findMatchingStudyForNifti(file.name, studies) as any;
    if (inferredStudy) {
      const inferredSeries = inferredStudy.series?.[0];
      return {
        fileKind,
        referenceStudyInstanceUID: inferredStudy.StudyInstanceUID,
        referenceSeriesInstanceUID: inferredSeries?.SeriesInstanceUID,
      };
    }

    if (!studies.length) {
      window.alert('No existing studies are available to link this segmentation to.');
      return { fileKind: NIFTI_IMPORT_KINDS.VOLUME };
    }

    const studyMenu = studies
      .map((study, index) => {
        const firstSeries = study.series?.[0];
        const description = firstSeries?.instances?.[0]?.StudyDescription || study.description || '';
        const seriesDescription = firstSeries?.instances?.[0]?.SeriesDescription || '';
        return `${index + 1}. ${description || study.StudyInstanceUID}${
          seriesDescription ? ` / ${seriesDescription}` : ''
        }`;
      })
      .join('\n');

    const selection = window.prompt(
      `Select the study to link this segmentation to:\n${studyMenu}`,
      '1'
    );
    const selectedIndex = Number.parseInt(selection || '1', 10) - 1;
    const selectedStudy = studies[selectedIndex] as any;

    if (!selectedStudy) {
      window.alert('Invalid study selection. Importing this file as a volume instead.');
      return { fileKind: NIFTI_IMPORT_KINDS.VOLUME };
    }

    const selectedSeries = selectedStudy.series?.[0];
    return {
      fileKind,
      referenceStudyInstanceUID: selectedStudy.StudyInstanceUID,
      referenceSeriesInstanceUID: selectedSeries?.SeriesInstanceUID,
    };
  };

  const onDrop = async acceptedFiles => {
    const studies = await filesToStudies(acceptedFiles, dataSource, {
      resolveNiftiOptions,
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
      onDrop={acceptedFiles => {
        setDropInitiated(true);
        onDrop(acceptedFiles);
      }}
      noClick
    >
      {({ getRootProps }) => (
        <div
          {...getRootProps()}
          style={{ width: '100%', height: '100%' }}
        >
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
