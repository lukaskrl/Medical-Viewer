import React, { useCallback, useState } from 'react';
import Dropzone from 'react-dropzone';
import { Button } from '@ohif/ui-next';
import { DicomMetadataStore } from '@ohif/core';

import filesToStudies from './filesToStudies';
import { isNiftiFile } from './niftiFileLoader';
import NiftiImportModal from './NiftiImportModal';

type StudyOption = {
  StudyInstanceUID: string;
  SeriesInstanceUID?: string;
  label: string;
};

type ViewerDicomUploadProps = {
  dataSource: any;
  variant?: 'modal' | 'inline';
  getExistingStudyOptions?: () => StudyOption[];
  onUploaded?: (studyInstanceUIDs: string[]) => void;
  onClose?: () => void;
  children?: React.ReactNode;
};

/**
 * Reusable upload UI for adding DICOM / NIfTI files to the in-memory store
 * while the viewer is open. Routes the dropped files through the same
 * `filesToStudies` pipeline used by the worklist and the Local route, so the
 * NIfTI volume/segmentation confirmation flow works identically here.
 *
 * - `variant="modal"` renders the full-size dropzone meant for the upload
 *   dialog opened from the side panel header.
 * - `variant="inline"` renders the compact drop area shown below the loaded
 *   studies in the StudyBrowser panel.
 */
function ViewerDicomUpload({
  dataSource,
  variant = 'modal',
  getExistingStudyOptions,
  onUploaded,
  onClose,
  children,
}: ViewerDicomUploadProps) {
  const [pendingNiftiImport, setPendingNiftiImport] = useState<{
    acceptedFiles: File[];
    niftiFiles: File[];
  } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const importFiles = useCallback(
    async (acceptedFiles: File[], niftiOptionsByFile: Map<File, any> | null) => {
      if (!acceptedFiles?.length) {
        return;
      }
      setIsProcessing(true);
      try {
        // Snapshot which series each study has *before* upload. NIfTI
        // segmentations linked to an existing study reuse that study's UID
        // and add a new series to it, so comparing only study UIDs misses
        // segmentation uploads entirely.
        const beforeSeriesByStudy = snapshotSeriesByStudy();
        await filesToStudies(acceptedFiles, dataSource, { niftiOptionsByFile });
        const afterSeriesByStudy = snapshotSeriesByStudy();
        const affectedStudyIds = diffAffectedStudies(beforeSeriesByStudy, afterSeriesByStudy);

        // `filesToStudies` only calls DicomMetadataStore.addInstance, which
        // doesn't broadcast events. Replay the data source's metadata
        // retrieval for any study that gained a series — this is the same
        // call defaultRouteInit makes for URL-supplied studies and fires
        // SERIES_ADDED + INSTANCES_ADDED, which the route-init subscription
        // turns into displaySetService.makeDisplaySets (idempotent for
        // already-known series).
        if (dataSource?.retrieve?.series?.metadata) {
          await Promise.all(
            affectedStudyIds.map(StudyInstanceUID =>
              Promise.resolve(
                dataSource.retrieve.series.metadata({
                  StudyInstanceUID,
                  madeInClient: true,
                })
              ).catch(err => console.error('Failed to load uploaded study', err))
            )
          );
        }

        onUploaded?.(affectedStudyIds);
      } finally {
        setIsProcessing(false);
      }
    },
    [dataSource, onUploaded]
  );

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!acceptedFiles?.length) {
        return;
      }
      const niftiFiles = acceptedFiles.filter(isNiftiFile);
      if (niftiFiles.length > 0) {
        setPendingNiftiImport({ acceptedFiles, niftiFiles });
        return;
      }
      await importFiles(acceptedFiles, null);
    },
    [importFiles]
  );

  const handleNiftiConfirm = (resolution: Map<File, any>) => {
    const pending = pendingNiftiImport;
    setPendingNiftiImport(null);
    if (pending) {
      importFiles(pending.acceptedFiles, resolution);
    }
  };

  const handleNiftiCancel = () => {
    setPendingNiftiImport(null);
  };

  const renderFileButton = (label: string, isDir: boolean) => (
    <Dropzone
      onDrop={onDrop}
      noDrag
    >
      {({ getRootProps, getInputProps }) => (
        <div {...getRootProps()}>
          <Button
            variant={isDir ? 'secondary' : 'default'}
            size={variant === 'modal' ? 'lg' : 'sm'}
            disabled={isProcessing}
            onClick={() => {}}
          >
            {label}
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

  const niftiModal = pendingNiftiImport ? (
    <NiftiImportModal
      files={pendingNiftiImport.niftiFiles}
      studies={getExistingStudyOptions?.() ?? []}
      onConfirm={handleNiftiConfirm}
      onCancel={handleNiftiCancel}
    />
  ) : null;

  if (variant === 'inline') {
    return (
      <>
        {niftiModal}
        <Dropzone
          onDrop={onDrop}
          noClick
        >
          {({ getRootProps, isDragActive }) => (
            <div
              {...getRootProps()}
              className="relative flex min-h-0 flex-1 flex-col"
            >
              {children}
              <div className="flex justify-center gap-2 py-2">
                {renderFileButton('Add files', false)}
                {renderFileButton('Add folder', true)}
              </div>
              {isDragActive && (
                <div className="border-primary bg-primary/10 pointer-events-none absolute inset-0 rounded-md border-2 border-dashed" />
              )}
            </div>
          )}
        </Dropzone>
      </>
    );
  }

  return (
    <>
      {niftiModal}
      <Dropzone
        onDrop={onDrop}
        noClick
      >
        {({ getRootProps }) => (
          <div
            {...getRootProps()}
            className="bg-background m-5 flex h-[360px] flex-col items-center justify-center rounded-2xl border"
            style={{ borderColor: 'hsl(var(--muted-foreground) / 0.25)' }}
          >
            <div className="flex gap-2">
              {renderFileButton('Add files', false)}
              {renderFileButton('Add folder', true)}
            </div>
            <div className="text-foreground pt-6 text-base">
              or drag images or folders here
            </div>
            <div className="text-muted-foreground pt-1 text-sm">
              DICOM (.dcm) and NIfTI (.nii, .nii.gz) supported. Data stays in this browser session.
            </div>
            {onClose && (
              <div className="pt-6">
                <Button
                  variant="ghost"
                  onClick={onClose}
                >
                  Close
                </Button>
              </div>
            )}
          </div>
        )}
      </Dropzone>
    </>
  );
}

function snapshotSeriesByStudy(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const studyIds = DicomMetadataStore.getStudyInstanceUIDs() as string[];
  studyIds.forEach(sid => {
    const study = DicomMetadataStore.getStudy(sid) as any;
    const seriesUIDs = new Set<string>(
      (study?.series ?? []).map((s: any) => s.SeriesInstanceUID).filter((s: any) => !!s)
    );
    map.set(sid, seriesUIDs);
  });
  return map;
}

function diffAffectedStudies(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>
): string[] {
  const affected: string[] = [];
  for (const [studyId, afterSeries] of after) {
    const beforeSeries = before.get(studyId);
    if (!beforeSeries) {
      affected.push(studyId);
      continue;
    }
    for (const seriesId of afterSeries) {
      if (!beforeSeries.has(seriesId)) {
        affected.push(studyId);
        break;
      }
    }
  }
  return affected;
}

export default ViewerDicomUpload;
