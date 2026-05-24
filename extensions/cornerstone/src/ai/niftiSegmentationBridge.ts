/**
 * Lightweight bridge for handing AI-generated segmentations to the existing
 * platform/app NIfTI loader without introducing a circular package dependency.
 *
 * platform/app's entry calls `registerNiftiSegmentationLoader(...)` once on
 * startup. The AI Models panel (this extension) reads the registered function
 * at run-time. If nothing is registered, the panel surfaces an error.
 */

export type AddNiftiOptions = {
  fileKind: 'segmentation';
  referenceStudyInstanceUID?: string;
  referenceSeriesInstanceUID?: string;
  referenceDisplaySetInstanceUID?: string;
  segmentLabels?: Record<number | string, string>;
  seriesDescription?: string;
};

export type AddNiftiToMetadataStore = (file: File, options: AddNiftiOptions) => Promise<string>;

let registered: AddNiftiToMetadataStore | null = null;

export function registerNiftiSegmentationLoader(fn: AddNiftiToMetadataStore): void {
  registered = fn;
}

export function getNiftiSegmentationLoader(): AddNiftiToMetadataStore {
  if (!registered) {
    throw new Error(
      'NIfTI segmentation loader is not registered. ' +
        'platform/app should call registerNiftiSegmentationLoader on startup.'
    );
  }
  return registered;
}
