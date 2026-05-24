import {
  buildNiftiBuffer,
  gzipNifti,
  type NiftiWritableVolume,
} from '@ohif/extension-cornerstone-dicom-seg/src/utils/niftiWriter';
import type { ImageVolume } from '../utils/extractDisplaySetVolume';
import { getNiftiSegmentationLoader } from './niftiSegmentationBridge';

interface LabelmapPayload {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
}

export interface LoadAiSegmentationOptions {
  /** Source CT volume — provides geometry the labelmap inherits. */
  referenceVolume: ImageVolume;
  /** Predicted labelmap, in the same (i, j, k) layout as referenceVolume.data. */
  labelmap: LabelmapPayload;
  /** Maps segment index → human-readable label (e.g. {1: 'L5'}). */
  labelNames: Record<number, string>;
  /** Display set the labelmap was generated from. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  referenceDisplaySet: any;
  /** Cosmetic label shown in the Segmentation panel. */
  seriesDescription: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  servicesManager: any;
  viewportId: string;
}

/**
 * Build a NIfTI Blob from an AI labelmap and route it through the existing
 * NIfTI segmentation import path (registered by platform/app) so it lands in
 * the Segmentation panel.
 */
export async function loadAiSegmentation(opts: LoadAiSegmentationOptions): Promise<void> {
  const { referenceVolume, labelmap, labelNames, referenceDisplaySet, servicesManager, viewportId } =
    opts;

  const niftiVolume: NiftiWritableVolume = {
    data: labelmap.data,
    width: labelmap.width,
    height: labelmap.height,
    depth: labelmap.depth,
    spacing: referenceVolume.spacing,
    origin: referenceVolume.origin,
    rowDirection: referenceVolume.rowDirection,
    columnDirection: referenceVolume.columnDirection,
    sliceDirection: referenceVolume.sliceDirection,
    label: opts.seriesDescription,
  };

  const arrayBuffer = buildNiftiBuffer(niftiVolume);
  const gzipped = gzipNifti(arrayBuffer);
  const blob = new Blob([gzipped], { type: 'application/gzip' });
  const safeName = opts.seriesDescription.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const file = new File([blob], `${safeName}_seg.nii.gz`, { type: 'application/gzip' });

  const addNifti = getNiftiSegmentationLoader();
  await addNifti(file, {
    fileKind: 'segmentation',
    referenceStudyInstanceUID: referenceDisplaySet.StudyInstanceUID,
    referenceSeriesInstanceUID: referenceDisplaySet.SeriesInstanceUID,
    referenceDisplaySetInstanceUID: referenceDisplaySet.displaySetInstanceUID,
    segmentLabels: labelNames,
    seriesDescription: opts.seriesDescription,
  });

  const { displaySetService, hangingProtocolService, viewportGridService } =
    servicesManager.services;
  const newSegDisplaySet = await waitForSegDisplaySet(
    displaySetService,
    referenceDisplaySet.displaySetInstanceUID,
    5000
  );
  if (!newSegDisplaySet) {
    console.warn('AI segmentation: SEG display set did not appear in time');
    return;
  }

  // Same pipeline a Studies-panel thumbnail double-click runs (see
  // extensions/default/.../studyBrowserCustomization.ts): ask the hanging
  // protocol which viewports should receive the SEG, then push via the
  // viewport grid. The cornerstone viewport service then handles
  // displaySet.load(), segmentation creation, and representation conversion
  // (labelmap on 2D MPRs, surface on VOLUME_3D).
  const { isHangingProtocolLayout } = viewportGridService.getState();
  const updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
    viewportId,
    newSegDisplaySet.displaySetInstanceUID,
    isHangingProtocolLayout
  );
  if (!updatedViewports?.length) {
    console.warn('AI segmentation: hanging protocol returned no viewports for SEG');
    return;
  }
  viewportGridService.setDisplaySetsForViewports(updatedViewports);
}

async function waitForSegDisplaySet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  displaySetService: any,
  referencedDisplaySetInstanceUID: string,
  timeoutMs: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const findMatch = () => {
    const sets = displaySetService.getActiveDisplaySets?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const segs = sets.filter((ds: any) => ds.Modality === 'SEG' && ds.isOverlayDisplaySet);
    if (!segs.length) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matching = segs.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ds: any) =>
        !ds.referencedDisplaySetInstanceUID ||
        ds.referencedDisplaySetInstanceUID === referencedDisplaySetInstanceUID
    );
    return matching[matching.length - 1] ?? segs[segs.length - 1];
  };

  const immediate = findMatch();
  if (immediate) {
    return immediate;
  }

  return new Promise(resolve => {
    let resolved = false;
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      unsubscribe?.();
      resolve(findMatch());
    }, timeoutMs);

    const subscription = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_ADDED,
      () => {
        const match = findMatch();
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve(match);
        }
      }
    );
    unsubscribe = subscription?.unsubscribe ?? null;
  });
}
