import React, { useEffect, useMemo, useState } from 'react';
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
import { readNiftiFileGeometry } from './niftiFileLoader';
import { isNrrdFile, readNrrdFileGeometry } from './nrrdFileLoader';
import {
  formatGeometry,
  geometriesMatch,
  getReferenceSeriesCandidates,
  pickMatchingReference,
} from './segmentationReference';

const AUTO_REFERENCE = 'auto';
const FILE_PREFIX = 'file:';
const SERIES_PREFIX = 'series:';

// Grid signature from segmentationReference; undefined while the header is
// still being read, null if it could not be read.
type Geometry = Record<string, unknown> | null | undefined;

type ReferenceCandidate = {
  StudyInstanceUID?: string;
  SeriesInstanceUID?: string;
  label: string;
  lookupName: string;
  isBlankCanvas: boolean;
  geometry: Geometry;
  // A canvas an earlier segmentation in this batch will create.
  plannedBy?: string;
};

type Hint = {
  tone: 'info' | 'match' | 'warning';
  text: string;
};

type NiftiImportModalProps = {
  files: File[];
  // DICOM (or other) files dropped alongside; they are imported before the
  // NIfTI/NRRD files, so a segmentation may still match one of them.
  hasOtherFiles?: boolean;
  onConfirm: (resolution: Map<File, Record<string, unknown>>) => void;
  onCancel: () => void;
};

const HINT_TONE_CLASSES: Record<Hint['tone'], string> = {
  info: 'text-muted-foreground',
  match: 'text-primary',
  warning: 'text-yellow-500',
};

/**
 * Describes the reference each segmentation will get, mirroring the import:
 * loaded series first, then this batch's volumes (imported before any
 * segmentation), then canvases created by earlier segmentations in the batch.
 */
function getReferenceHints(
  entries,
  geometries: Map<File, Geometry>,
  loadedCandidates,
  hasOtherFiles: boolean
) {
  const batchVolumes: ReferenceCandidate[] = entries
    .filter(entry => entry.kind === NIFTI_IMPORT_KINDS.VOLUME)
    .map(entry => ({
      label: entry.file.name,
      lookupName: normalizeLookupName(entry.file.name),
      isBlankCanvas: false,
      geometry: geometries.get(entry.file),
    }));
  const isReadingBatch = batchVolumes.some(volume => volume.geometry === undefined);
  const plannedCanvases: ReferenceCandidate[] = [];
  const hints = new Map<File, Hint>();

  entries.forEach(entry => {
    if (entry.kind !== NIFTI_IMPORT_KINDS.SEGMENTATION) {
      return;
    }

    const geometry = geometries.get(entry.file);
    const linkedTarget = entry.reference.startsWith(FILE_PREFIX)
      ? batchVolumes.find(volume => `${FILE_PREFIX}${volume.label}` === entry.reference)
      : loadedCandidates.find(
          candidate => `${SERIES_PREFIX}${candidate.SeriesInstanceUID}` === entry.reference
        );

    if (linkedTarget) {
      if (geometry && linkedTarget.geometry && !geometriesMatch(geometry, linkedTarget.geometry)) {
        hints.set(entry.file, {
          tone: 'warning',
          text: `Grid ${formatGeometry(geometry)} differs from ${linkedTarget.label} (${formatGeometry(
            linkedTarget.geometry
          )}). It may not line up.`,
        });
      }
      return;
    }

    if (geometry === undefined || isReadingBatch) {
      hints.set(entry.file, { tone: 'info', text: 'Reading grid…' });
      return;
    }

    if (geometry === null) {
      hints.set(entry.file, { tone: 'info', text: 'Matched by grid during import.' });
      return;
    }

    const match = pickMatchingReference(
      [...loadedCandidates, ...batchVolumes, ...plannedCanvases],
      geometry,
      entry.file.name
    );

    if (match?.plannedBy) {
      hints.set(entry.file, {
        tone: 'match',
        text: `Shares a new blank canvas with ${match.plannedBy}.`,
      });
      return;
    }

    if (match) {
      hints.set(entry.file, {
        tone: 'match',
        text: match.isBlankCanvas
          ? `Joins the existing ${match.label}.`
          : `Same grid as ${match.label}.`,
      });
      return;
    }

    plannedCanvases.push({
      label: `Blank canvas ${formatGeometry(geometry)}`,
      lookupName: '',
      isBlankCanvas: true,
      geometry,
      plannedBy: entry.file.name,
    });

    // Point out a volume that looks like the source but has another grid
    // (e.g. a cropped segmentation), since that is the usual surprise here.
    const lookupName = normalizeLookupName(entry.file.name);
    const sameName = [...loadedCandidates, ...batchVolumes].find(
      candidate => !candidate.isBlankCanvas && candidate.lookupName === lookupName
    );
    hints.set(
      entry.file,
      sameName
        ? {
            tone: 'warning',
            text: `New blank canvas ${formatGeometry(geometry)}. ${sameName.label} has a different grid (${formatGeometry(
              sameName.geometry
            )}).`,
          }
        : {
            tone: 'info',
            text: hasOtherFiles
              ? `New blank canvas ${formatGeometry(geometry)}, unless a DICOM series in this drop has the same grid.`
              : `New blank canvas ${formatGeometry(geometry)}.`,
          }
    );
  });

  return hints;
}

/**
 * Lists every dropped NIfTI/NRRD file so the user can confirm or correct whether
 * each one is a volume or a segmentation. Segmentations default to "Auto": they
 * reference a volume with the same grid, or share a blank canvas with other
 * segmentations on that grid. The user can still link one explicitly.
 */
function NiftiImportModal({
  files,
  hasOtherFiles = false,
  onConfirm,
  onCancel,
}: NiftiImportModalProps) {
  const [entries, setEntries] = useState(() =>
    files.map(file => ({
      file,
      kind: inferNiftiImportKind(file.name),
      reference: AUTO_REFERENCE,
    }))
  );
  const [geometries, setGeometries] = useState<Map<File, Geometry>>(() => new Map());
  const loadedCandidates = useMemo(() => getReferenceSeriesCandidates(), []);

  // Read each file's grid from its header so the hints can say where a
  // segmentation will land before anything is imported.
  useEffect(() => {
    let cancelled = false;
    files.forEach(file => {
      const readGeometry = isNrrdFile(file) ? readNrrdFileGeometry : readNiftiFileGeometry;
      readGeometry(file).then(geometry => {
        if (!cancelled) {
          setGeometries(prev => new Map(prev).set(file, geometry));
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [files]);

  const volumeFileNames = useMemo(
    () =>
      entries
        .filter(entry => entry.kind === NIFTI_IMPORT_KINDS.VOLUME)
        .map(entry => entry.file.name),
    [entries]
  );

  const hints = useMemo(
    () => getReferenceHints(entries, geometries, loadedCandidates, hasOtherFiles),
    [entries, geometries, loadedCandidates, hasOtherFiles]
  );

  const setKind = (index: number, kind: string) => {
    setEntries(prev =>
      prev.map((entry, i) => (i === index ? { ...entry, kind, reference: AUTO_REFERENCE } : entry))
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

      // Without a reference the loader matches the segmentation by grid.
      const options: Record<string, unknown> = { fileKind: NIFTI_IMPORT_KINDS.SEGMENTATION };

      if (entry.reference.startsWith(FILE_PREFIX)) {
        const fileName = entry.reference.slice(FILE_PREFIX.length);
        // Only keep the link if the target is still marked as a volume.
        if (volumeFileNames.includes(fileName)) {
          options.referenceFileName = fileName;
        }
      } else if (entry.reference.startsWith(SERIES_PREFIX)) {
        const candidate = loadedCandidates.find(
          item => `${SERIES_PREFIX}${item.SeriesInstanceUID}` === entry.reference
        );
        if (candidate) {
          options.referenceStudyInstanceUID = candidate.StudyInstanceUID;
          options.referenceSeriesInstanceUID = candidate.SeriesInstanceUID;
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
            Review the auto-detected file types. Each segmentation is placed on a volume with the
            same grid. Segmentations without one share a blank canvas, so they can be viewed
            together.
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
            const hint = isSegmentation ? hints.get(entry.file) : null;

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
                    <span className="text-muted-foreground shrink-0 text-xs">Place on:</span>
                    <Select
                      value={entry.reference}
                      onValueChange={value => setReference(index, value)}
                    >
                      <SelectTrigger className="h-7 flex-1 text-xs">
                        <SelectValue placeholder="Choose reference…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO_REFERENCE}>Auto (match by grid)</SelectItem>
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
                        {loadedCandidates.length > 0 && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-xs">Loaded series</SelectLabel>
                              {loadedCandidates.map(candidate => (
                                <SelectItem
                                  key={`${SERIES_PREFIX}${candidate.SeriesInstanceUID}`}
                                  value={`${SERIES_PREFIX}${candidate.SeriesInstanceUID}`}
                                >
                                  {candidate.label}
                                  {/* Canvas labels already carry their grid. */}
                                  {candidate.geometry && !candidate.isBlankCanvas && (
                                    <span className="text-muted-foreground">
                                      {` · ${formatGeometry(candidate.geometry)}`}
                                    </span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {hint && (
                  <p className={['ml-8 mt-1.5 text-xs', HINT_TONE_CLASSES[hint.tone]].join(' ')}>
                    {hint.text}
                  </p>
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
