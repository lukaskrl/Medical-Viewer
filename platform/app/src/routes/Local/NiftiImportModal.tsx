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
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  Button,
  Icons,
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
 * Lists every dropped NIfTI/NRRD file so the user can confirm or correct whether
 * each one is a volume or a segmentation (and, for segmentations, which
 * volume/study it belongs to) before importing.
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

    const defaultStudyReference = studies[0]
      ? `${STUDY_PREFIX}${studies[0].StudyInstanceUID}`
      : NO_REFERENCE;

    return inferred.map(entry => {
      if (entry.kind !== NIFTI_IMPORT_KINDS.SEGMENTATION) {
        return entry;
      }

      // Pre-link a segmentation to a batch volume that shares its base name.
      const match = volumeNames.find(
        name => normalizeLookupName(name) === normalizeLookupName(entry.file.name)
      );

      if (match) {
        return { ...entry, reference: `${FILE_PREFIX}${match}` };
      }

      // Fall back to the first batch volume (if any), then the first loaded study.
      const firstBatchVolume = volumeNames[0];
      if (firstBatchVolume) {
        return { ...entry, reference: `${FILE_PREFIX}${firstBatchVolume}` };
      }

      return { ...entry, reference: defaultStudyReference };
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
    setEntries(prev => {
      const updated = prev.map((entry, i) =>
        i === index ? { ...entry, kind, reference: NO_REFERENCE } : entry
      );

      if (kind !== NIFTI_IMPORT_KINDS.SEGMENTATION) {
        return updated;
      }

      // Compute volumes after the switch so the entry being changed is excluded.
      const newVolumeNames = updated
        .filter(e => e.kind === NIFTI_IMPORT_KINDS.VOLUME)
        .map(e => e.file.name);

      const fileName = prev[index].file.name;
      const match = newVolumeNames.find(
        name => normalizeLookupName(name) === normalizeLookupName(fileName)
      );

      let reference: string;
      if (match) {
        reference = `${FILE_PREFIX}${match}`;
      } else if (newVolumeNames[0]) {
        reference = `${FILE_PREFIX}${newVolumeNames[0]}`;
      } else if (studies[0]) {
        reference = `${STUDY_PREFIX}${studies[0].StudyInstanceUID}`;
      } else {
        reference = NO_REFERENCE;
      }

      return updated.map((entry, i) => (i === index ? { ...entry, reference } : entry));
    });
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

  const volumeCount = entries.filter(e => e.kind === NIFTI_IMPORT_KINDS.VOLUME).length;
  const segCount = entries.filter(e => e.kind === NIFTI_IMPORT_KINDS.SEGMENTATION).length;

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
          <DialogTitle className="flex items-center gap-2">
            <Icons.Upload className="h-5 w-5 shrink-0" />
            Confirm import
          </DialogTitle>
          <DialogDescription className="text-white">
            Review the auto-detected file types. Link any segmentation to its reference volume
            before importing.
          </DialogDescription>
        </DialogHeader>

        {/* Summary badges */}
        <div className="flex gap-2">
          {volumeCount > 0 && (
            <span className="bg-primary/10 text-primary flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium">
              <Icons.LayerForeground className="h-3.5 w-3.5" />
              {volumeCount} volume{volumeCount !== 1 ? 's' : ''}
            </span>
          )}
          {segCount > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-purple-500/15 px-3 py-1 text-xs font-medium text-purple-400">
              <Icons.LayerSegmentation className="h-3.5 w-3.5" />
              {segCount} segmentation{segCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {entries.map((entry, index) => {
            const isSegmentation = entry.kind === NIFTI_IMPORT_KINDS.SEGMENTATION;
            const referenceTargets = volumeFileNames.filter(name => name !== entry.file.name);
            const TypeIcon = isSegmentation ? Icons.LayerSegmentation : Icons.LayerForeground;

            return (
              <div
                key={`${entry.file.name}-${index}`}
                className={[
                  'rounded-lg border-l-2 p-3 transition-colors',
                  'bg-muted/50',
                  isSegmentation ? 'border-l-purple-500' : 'border-l-primary',
                ].join(' ')}
              >
                {/* Filename + type toggle row */}
                <div className="flex items-center gap-3">
                  <TypeIcon
                    className={[
                      'h-5 w-5 shrink-0',
                      isSegmentation ? 'text-purple-400' : 'text-primary',
                    ].join(' ')}
                  />
                  <span
                    className="text-foreground min-w-0 flex-1 truncate text-sm font-medium"
                    title={entry.file.name}
                  >
                    {entry.file.name}
                  </span>

                  {/* Compact two-button type toggle */}
                  <div className="border-border flex shrink-0 overflow-hidden rounded-md border">
                    <button
                      type="button"
                      className={[
                        'px-3 py-1 text-xs font-medium transition-colors',
                        !isSegmentation
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      ].join(' ')}
                      onClick={() => setKind(index, NIFTI_IMPORT_KINDS.VOLUME)}
                    >
                      Volume
                    </button>
                    <button
                      type="button"
                      className={[
                        'border-border border-l px-3 py-1 text-xs font-medium transition-colors',
                        isSegmentation
                          ? 'bg-purple-600 text-white'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      ].join(' ')}
                      onClick={() => setKind(index, NIFTI_IMPORT_KINDS.SEGMENTATION)}
                    >
                      Segmentation
                    </button>
                  </div>
                </div>

                {/* Reference selector — only shown for segmentations */}
                {isSegmentation && (
                  <div className="ml-8 mt-2.5 flex items-center gap-2">
                    <span className="text-muted-foreground shrink-0 text-xs">Link to volume:</span>
                    <Select
                      value={entry.reference}
                      onValueChange={value => setReference(index, value)}
                    >
                      <SelectTrigger className="h-7 flex-1 text-xs">
                        <SelectValue placeholder="Choose reference…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_REFERENCE}>No reference</SelectItem>
                        {referenceTargets.length > 0 && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-xs">From this batch</SelectLabel>
                              {referenceTargets.map(name => (
                                <SelectItem
                                  key={`${FILE_PREFIX}${name}`}
                                  value={`${FILE_PREFIX}${name}`}
                                >
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </>
                        )}
                        {studies.length > 0 && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-xs">Loaded studies</SelectLabel>
                              {studies.map(study => (
                                <SelectItem
                                  key={`${STUDY_PREFIX}${study.StudyInstanceUID}`}
                                  value={`${STUDY_PREFIX}${study.StudyInstanceUID}`}
                                >
                                  {study.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
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
            Import {entries.length} file{entries.length !== 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NiftiImportModal;
