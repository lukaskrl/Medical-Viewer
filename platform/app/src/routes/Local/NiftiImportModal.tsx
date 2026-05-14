import React, { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Button,
} from '@ohif/ui-next';

import {
  inferNiftiImportKind,
  normalizeLookupName,
  NIFTI_IMPORT_KINDS,
} from './niftiUploadOptions';

const NO_REFERENCE = '__none__';
const FILE_PREFIX = 'file:';
const STUDY_PREFIX = 'study:';

type StudyOption = {
  StudyInstanceUID: string;
  SeriesInstanceUID?: string;
  label: string;
};

type NiftiImportModalProps = {
  files: File[];
  studies?: StudyOption[];
  onConfirm: (resolution: Map<File, Record<string, unknown>>) => void;
  onCancel: () => void;
};

/**
 * Lists every dropped NIfTI file in a single menu so the user can confirm or
 * correct whether each one is a volume or a segmentation (and, for
 * segmentations, which volume/study it belongs to) before importing.
 */
function NiftiImportModal({ files, studies = [], onConfirm, onCancel }: NiftiImportModalProps) {
  const [entries, setEntries] = useState(() => {
    const inferred = files.map(file => ({
      file,
      kind: inferNiftiImportKind(file.name),
      reference: NO_REFERENCE,
    }));

    const volumeNames = inferred
      .filter(entry => entry.kind === NIFTI_IMPORT_KINDS.VOLUME)
      .map(entry => entry.file.name);

    return inferred.map(entry => {
      if (entry.kind !== NIFTI_IMPORT_KINDS.SEGMENTATION) {
        return entry;
      }

      // Pre-link a segmentation to a batch volume that shares its base name.
      const match = volumeNames.find(
        name => normalizeLookupName(name) === normalizeLookupName(entry.file.name)
      );

      return { ...entry, reference: match ? `${FILE_PREFIX}${match}` : NO_REFERENCE };
    });
  });

  const volumeFileNames = useMemo(
    () =>
      entries
        .filter(entry => entry.kind === NIFTI_IMPORT_KINDS.VOLUME)
        .map(entry => entry.file.name),
    [entries]
  );

  const setKind = (index: number, kind: string) => {
    setEntries(prev =>
      prev.map((entry, i) => (i === index ? { ...entry, kind, reference: NO_REFERENCE } : entry))
    );
  };

  const setReference = (index: number, reference: string) => {
    setEntries(prev => prev.map((entry, i) => (i === index ? { ...entry, reference } : entry)));
  };

  const handleConfirm = () => {
    const resolution = new Map<File, Record<string, unknown>>();

    entries.forEach(entry => {
      if (entry.kind !== NIFTI_IMPORT_KINDS.SEGMENTATION) {
        resolution.set(entry.file, { fileKind: NIFTI_IMPORT_KINDS.VOLUME });
        return;
      }

      const options: Record<string, unknown> = { fileKind: NIFTI_IMPORT_KINDS.SEGMENTATION };

      if (entry.reference?.startsWith(FILE_PREFIX)) {
        const fileName = entry.reference.slice(FILE_PREFIX.length);
        // Only keep the link if the target is still marked as a volume.
        if (volumeFileNames.includes(fileName)) {
          options.referenceFileName = fileName;
        }
      } else if (entry.reference?.startsWith(STUDY_PREFIX)) {
        const studyUID = entry.reference.slice(STUDY_PREFIX.length);
        const study = studies.find(item => item.StudyInstanceUID === studyUID);
        if (study) {
          options.referenceStudyInstanceUID = study.StudyInstanceUID;
          if (study.SeriesInstanceUID) {
            options.referenceSeriesInstanceUID = study.SeriesInstanceUID;
          }
        }
      }

      resolution.set(entry.file, options);
    });

    onConfirm(resolution);
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Confirm NIfTI import</DialogTitle>
          <DialogDescription>
            Choose whether each file is a volume or a segmentation. Segmentations can be linked to a
            reference volume from this batch or an existing study.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-2 overflow-y-auto py-1">
          {entries.map((entry, index) => {
            const isSegmentation = entry.kind === NIFTI_IMPORT_KINDS.SEGMENTATION;
            const referenceTargets = volumeFileNames.filter(name => name !== entry.file.name);

            return (
              <div
                key={`${entry.file.name}-${index}`}
                className="bg-muted flex flex-col gap-2 rounded-lg p-3"
              >
                <div
                  className="text-primary truncate text-sm font-medium"
                  title={entry.file.name}
                >
                  {entry.file.name}
                </div>
                <div className="flex gap-2">
                  <Select
                    value={entry.kind}
                    onValueChange={value => setKind(index, value)}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NIFTI_IMPORT_KINDS.VOLUME}>Volume</SelectItem>
                      <SelectItem value={NIFTI_IMPORT_KINDS.SEGMENTATION}>Segmentation</SelectItem>
                    </SelectContent>
                  </Select>

                  {isSegmentation && (
                    <Select
                      value={entry.reference}
                      onValueChange={value => setReference(index, value)}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Link to…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_REFERENCE}>No reference</SelectItem>
                        {referenceTargets.map(name => (
                          <SelectItem
                            key={`${FILE_PREFIX}${name}`}
                            value={`${FILE_PREFIX}${name}`}
                          >
                            {name} (this batch)
                          </SelectItem>
                        ))}
                        {studies.map(study => (
                          <SelectItem
                            key={`${STUDY_PREFIX}${study.StudyInstanceUID}`}
                            value={`${STUDY_PREFIX}${study.StudyInstanceUID}`}
                          >
                            {study.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleConfirm}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NiftiImportModal;
