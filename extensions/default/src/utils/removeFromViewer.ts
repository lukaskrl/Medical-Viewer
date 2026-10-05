import { DicomMetadataStore } from '@ohif/core';
import { configureViewportForLayerRemoval } from './layerConfigurationUtils';

type DisplaySet = AppTypes.DisplaySet;

const seriesKey = (displaySet: DisplaySet) =>
  `${displaySet.StudyInstanceUID}|${displaySet.SeriesInstanceUID}`;

/**
 * Expands the display sets picked for removal to everything that has to go
 * with them: the other display sets of the same series, since the series
 * leaves the metadata store as a whole, and the SEG / RTSTRUCT display sets
 * that reference a removed series, since they cannot be shown without it.
 */
export function collectDisplaySetsToRemove(
  selected: DisplaySet[],
  allDisplaySets: DisplaySet[]
): DisplaySet[] {
  const toRemove = new Map<string, DisplaySet>();
  const removedSeriesKeys = new Set<string>();
  const removedSeriesUIDs = new Set<string>();

  const add = (displaySet: DisplaySet) => {
    toRemove.set(displaySet.displaySetInstanceUID, displaySet);
    if (displaySet.SeriesInstanceUID) {
      removedSeriesKeys.add(seriesKey(displaySet));
      removedSeriesUIDs.add(displaySet.SeriesInstanceUID);
    }
  };

  selected.forEach(add);

  let added = true;
  while (added) {
    added = false;
    for (const displaySet of allDisplaySets) {
      if (toRemove.has(displaySet.displaySetInstanceUID)) {
        continue;
      }
      const isSameSeries =
        displaySet.SeriesInstanceUID && removedSeriesKeys.has(seriesKey(displaySet));
      const referencesRemoved =
        toRemove.has(displaySet.referencedDisplaySetInstanceUID) ||
        removedSeriesUIDs.has(displaySet.referencedSeriesInstanceUID);
      if (isSameSeries || referencesRemoved) {
        add(displaySet);
        added = true;
      }
    }
  }

  return [...toRemove.values()];
}

/**
 * Segmentations that belong to a removed SEG / RTSTRUCT display set, or that
 * were drawn on images being removed.
 */
export function findSegmentationsToRemove(
  segmentations: { segmentationId: string; representationData?: any }[],
  removedDisplaySetUIDs: Set<string>,
  removedImageIds: Set<string>
): string[] {
  return segmentations
    .filter(({ segmentationId, representationData }) => {
      if (removedDisplaySetUIDs.has(segmentationId)) {
        return true;
      }
      const referencedImageIds: string[] =
        representationData?.Labelmap?.referencedImageIds ??
        representationData?.Contour?.referencedImageIds ??
        [];
      return referencedImageIds.some(imageId => removedImageIds.has(imageId));
    })
    .map(({ segmentationId }) => segmentationId);
}

/**
 * Removes display sets from the current viewer session: their viewports,
 * segmentations, measurements and metadata. The data source is not touched,
 * so the same files can be loaded again afterwards.
 */
export async function removeDisplaySetsFromViewer(
  { servicesManager, extensionManager }: withAppTypes,
  displaySets: DisplaySet[]
): Promise<void> {
  const {
    displaySetService,
    viewportGridService,
    segmentationService,
    measurementService,
    hangingProtocolService,
  } = servicesManager.services;
  const [dataSource] = extensionManager.getActiveDataSource();

  const removedUIDs = new Set(displaySets.map(ds => ds.displaySetInstanceUID));
  // Resolved before the metadata is removed, which the data source needs.
  const removedImageIds = new Set<string>(
    displaySets.flatMap(ds => dataSource.getImageIdsForDisplaySet(ds) ?? [])
  );

  if (segmentationService) {
    findSegmentationsToRemove(
      segmentationService.getSegmentations(),
      removedUIDs,
      removedImageIds
    ).forEach(segmentationId => segmentationService.remove(segmentationId));
  }

  // The grid state only refreshes on the next render, so each viewport gets
  // one update computed from the current state rather than one per layer.
  const viewportsToUpdate = [];
  for (const [viewportId, viewport] of viewportGridService.getState().viewports) {
    const uids: string[] = viewport.displaySetInstanceUIDs ?? [];
    const removedLayers = uids.filter(uid => removedUIDs.has(uid));
    if (!removedLayers.length) {
      continue;
    }

    if (removedUIDs.has(uids[0]) || removedLayers.length === uids.length) {
      viewportsToUpdate.push({ viewportId, displaySetInstanceUIDs: [] });
      continue;
    }

    const updatedViewport = {
      viewportId,
      displaySetInstanceUIDs: uids,
      viewportOptions: { ...viewport.viewportOptions },
    };
    removedLayers.forEach(displaySetInstanceUID =>
      configureViewportForLayerRemoval({
        viewport: updatedViewport,
        displaySetInstanceUID,
        currentDisplaySetUIDs: updatedViewport.displaySetInstanceUIDs,
        servicesManager,
      })
    );
    viewportsToUpdate.push(updatedViewport);
  }

  if (viewportsToUpdate.length) {
    await viewportGridService.setDisplaySetsForViewports(viewportsToUpdate);
  }

  const removedSeriesUIDs = new Set(displaySets.map(ds => ds.SeriesInstanceUID).filter(Boolean));
  const measurementUIDs = measurementService
    .getMeasurements()
    .filter(measurement => removedSeriesUIDs.has(measurement.referenceSeriesUID))
    .map(measurement => measurement.uid);
  if (measurementUIDs.length) {
    measurementService.removeMany(measurementUIDs);
  }

  // Segmentation removal already deletes the display sets made in the client.
  removedUIDs.forEach(uid => {
    if (displaySetService.getDisplaySetByUID(uid)) {
      displaySetService.deleteDisplaySet(uid);
    }
  });

  const affectedStudyUIDs = new Set<string>();
  displaySets.forEach(({ StudyInstanceUID, SeriesInstanceUID }) => {
    if (StudyInstanceUID && SeriesInstanceUID) {
      DicomMetadataStore.removeSeries(StudyInstanceUID, SeriesInstanceUID);
      affectedStudyUIDs.add(StudyInstanceUID);
    }
  });

  pruneRemovedStudies(hangingProtocolService, affectedStudyUIDs);
}

/**
 * Removes a whole study from the current viewer session, including series
 * that have no display set.
 */
export async function removeStudyFromViewer(
  params: withAppTypes,
  StudyInstanceUID: string,
  displaySets: DisplaySet[]
): Promise<void> {
  await removeDisplaySetsFromViewer(params, displaySets);

  if (DicomMetadataStore.getStudy(StudyInstanceUID)) {
    DicomMetadataStore.removeStudy(StudyInstanceUID);
  } else {
    // Studies only known from a query (e.g. priors) were never in the store,
    // but the study browser still has to drop them.
    DicomMetadataStore._broadcastEvent(DicomMetadataStore.EVENTS.STUDY_REMOVED, {
      StudyInstanceUID,
    });
  }

  pruneRemovedStudies(params.servicesManager.services.hangingProtocolService, [StudyInstanceUID]);
}

/**
 * Keeps the hanging protocol from matching studies that are no longer
 * loaded. Its display set list is the display set service's own array, so
 * that one is already up to date.
 */
function pruneRemovedStudies(hangingProtocolService, studyUIDs: Iterable<string>) {
  const removed = new Set([...studyUIDs].filter(uid => !DicomMetadataStore.getStudy(uid)));
  if (!removed.size) {
    return;
  }
  hangingProtocolService.studies = hangingProtocolService.studies.filter(
    study => !removed.has(study.StudyInstanceUID)
  );
  if (removed.has(hangingProtocolService.activeStudy?.StudyInstanceUID)) {
    hangingProtocolService.activeStudy = hangingProtocolService.studies[0];
  }
}
