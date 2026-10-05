import { cache, getRenderingEngines } from '@cornerstonejs/core';
import { DicomMetadataStore } from '@ohif/core';

const RETRY_MS = 200;
const MAX_ATTEMPTS = 50;

/**
 * Frees the cached volumes, and their images, of display sets and series
 * removed from the viewer. Viewports showing removed data are only cleared on
 * the next render, so each volume is released once no viewport renders it.
 *
 * @returns a function that stops listening
 */
export function initReleaseRemovedVolumes(displaySetService: AppTypes.DisplaySetService) {
  // Volumes OHIF creates for a display set are named after it.
  const displaySetsRemoved = displaySetService.subscribe(
    displaySetService.EVENTS.DISPLAY_SETS_REMOVED,
    ({ displaySetInstanceUIDs }: { displaySetInstanceUIDs: string[] }) => {
      cache
        .getVolumes()
        .filter(({ volumeId }) => displaySetInstanceUIDs.some(uid => volumeId.endsWith(`:${uid}`)))
        .forEach(({ volumeId }) => releaseWhenUnused(volumeId, MAX_ATTEMPTS));
    }
  );

  // Others, such as the labelmap volume of a loaded NIfTI segmentation, are
  // built from the series images.
  const seriesRemoved = DicomMetadataStore.subscribe(
    DicomMetadataStore.EVENTS.SERIES_REMOVED,
    ({ series }) => {
      const imageIds = new Set(
        (series?.instances ?? []).map(instance => instance.imageId ?? instance.url)
      );
      cache
        .getVolumes()
        .filter(volume => volume.imageIds?.some(imageId => imageIds.has(imageId)))
        .forEach(({ volumeId }) => releaseWhenUnused(volumeId, MAX_ATTEMPTS));
    }
  );

  return () => {
    displaySetsRemoved.unsubscribe();
    seriesRemoved.unsubscribe();
  };
}

// Checks the actors, as viewport.hasVolumeId stays true for volumes the
// viewport no longer shows.
function isRendered(volumeId: string): boolean {
  return getRenderingEngines().some(renderingEngine =>
    renderingEngine
      .getViewports()
      .some(viewport =>
        viewport
          .getActors()
          .some(actor => actor.referencedId === volumeId || actor.uid === volumeId)
      )
  );
}

function releaseWhenUnused(volumeId: string, attemptsLeft: number) {
  const volume = cache.getVolume(volumeId);
  if (!volume) {
    return;
  }
  if (isRendered(volumeId)) {
    if (attemptsLeft > 0) {
      setTimeout(() => releaseWhenUnused(volumeId, attemptsLeft - 1), RETRY_MS);
    }
    return;
  }

  const imageIds = volume.imageIds ?? [];
  cache.removeVolumeLoadObject(volumeId);
  imageIds.forEach(imageId => {
    if (cache.getImageLoadObject(imageId)) {
      cache.removeImageLoadObject(imageId, { force: true });
    }
  });
}
