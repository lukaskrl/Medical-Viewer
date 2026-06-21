import * as cornerstoneTools from '@cornerstonejs/tools';
import { updateSegmentationStats } from './updateSegmentationStats';
import { useSelectedSegmentationsForViewportStore } from '../stores';
import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';

/**
 * Sets up the handler for segmentation data modification events
 */
export function setupSegmentationDataModifiedHandler({
  segmentationService,
  customizationService,
  commandsManager,
}) {
  // A flag to indicate if the event is unsubscribed to. This is important because
  // the debounced callback does an await and in that period of time the event may have
  // been unsubscribed.
  let isUnsubscribed = false;
  const { unsubscribe: debouncedUnsubscribe } = segmentationService.subscribeDebounced(
    segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
    async ({ segmentationId, modifiedSlicesToUse, segmentIndex: modifiedSegmentIndex }) => {
      const disableUpdateSegmentationStats = customizationService.getCustomization(
        'panelSegmentation.disableUpdateSegmentationStats'
      );

      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation || disableUpdateSegmentationStats) {
        return;
      }

      const segmentIndices = Object.keys(segmentation.segments)
        .map(index => parseInt(index))
        .filter(index => index > 0);

      // Skip the expensive whole-volume stats recompute when nothing actually
      // changed. Cornerstone emits SEGMENTATION_DATA_MODIFIED with only a
      // segmentationId every time a representation is added to a viewport (e.g.
      // on a single->MPR layout switch, once per new viewport). Treating those
      // as data changes used to trigger a getStatistics pass (iterates every
      // voxel) plus an addOrUpdateSegmentation re-broadcast per viewport,
      // snowballing into many redundant segmentation re-renders.
      //
      // We must still compute on (a) real voxel edits - brush/threshold/paint
      // fill carry modifiedSlicesToUse and/or a segmentIndex - and (b) initial
      // load, where stats don't exist yet and this handler is what populates
      // them. So only bail out when stats already exist AND this isn't an edit.
      const hasModifiedSlices = Array.isArray(modifiedSlicesToUse)
        ? modifiedSlicesToUse.length > 0
        : modifiedSlicesToUse !== undefined;
      const isRealVoxelEdit = hasModifiedSlices || modifiedSegmentIndex !== undefined;
      const allSegmentsHaveStats =
        segmentIndices.length > 0 &&
        segmentIndices.every(index => {
          const namedStats = segmentation.segments[index]?.cachedStats?.namedStats;
          return namedStats && Object.keys(namedStats).length > 0;
        });
      if (allSegmentsHaveStats && !isRealVoxelEdit) {
        return;
      }

      const readableText = customizationService.getCustomization('panelSegmentation.readableText');

      // Check for segments with bidirectional measurements and update them
      for (const segmentIndex of segmentIndices) {
        const segment = segmentation.segments[segmentIndex];
        if (segment?.cachedStats?.namedStats?.bidirectional) {
          // Run the command to update the bidirectional measurement
          commandsManager.runCommand('runSegmentBidirectional', {
            segmentationId,
            segmentIndex,
          });
        }
      }

      const updatedSegmentation = await updateSegmentationStats({
        segmentation,
        segmentationId,
        readableText,
      });

      if (!isUnsubscribed && updatedSegmentation) {
        segmentationService.addOrUpdateSegmentation({
          segmentationId,
          segments: updatedSegmentation.segments,
        });
      }
    },
    1000
  );

  const unsubscribe = () => {
    isUnsubscribed = true;
    debouncedUnsubscribe();
  };
  return { unsubscribe };
}

/**
 * Sets up the handler for segmentation modification events
 */
export function setupSegmentationModifiedHandler({ segmentationService }) {
  const { unsubscribe } = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_MODIFIED,
    async ({ segmentationId }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        return;
      }

      const annotationState = cornerstoneTools.annotation.state.getAllAnnotations();
      const bidirectionalAnnotations = annotationState.filter(
        annotation =>
          annotation.metadata.toolName === cornerstoneTools.SegmentBidirectionalTool.toolName
      );

      const segmentIndices = Object.keys(segmentation.segments)
        .map(index => parseInt(index))
        .filter(index => index > 0);

      // check if there is a bidirectional data that exists but the segment
      // does not exists anymore we need to remove the bidirectional data
      const bidirectionalAnnotationsToRemove = bidirectionalAnnotations.filter(
        annotation =>
          annotation.metadata.segmentationId === segmentationId &&
          !segmentIndices.includes(annotation.metadata.segmentIndex)
      );

      const toRemoveUIDs = bidirectionalAnnotationsToRemove.map(
        annotation => annotation.annotationUID
      );

      toRemoveUIDs.forEach(uid => {
        cornerstoneTools.annotation.state.removeAnnotation(uid);
      });
    }
  );

  return { unsubscribe };
}

/**
 * Sets up auto tab switching for when the first segmentation is added into the viewer.
 */
export function setUpSelectedSegmentationsForViewportHandler({ segmentationService }) {
  const selectedSegmentationsForViewportEvents = [
    segmentationService.EVENTS.SEGMENTATION_MODIFIED,
    segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
  ];

  const unsubscribeSelectedSegmentationsForViewportEvents = selectedSegmentationsForViewportEvents
    .map(eventName =>
      segmentationService.subscribe(eventName, event => {
        const { viewportId } = event;

        if (!viewportId) {
          return;
        }

        const { selectedSegmentationsForViewport, setSelectedSegmentationsForViewport } =
          useSelectedSegmentationsForViewportStore.getState();

        const representations = segmentationService.getSegmentationRepresentations(viewportId);

        const activeRepresentation = representations.find(representation => representation.active);

        // Build a new Map (rather than mutating in place) so the store update
        // produces a fresh reference and reliably re-renders subscribers.
        const typeToSegmentationIdMap = new Map<SegmentationRepresentations, string>(
          selectedSegmentationsForViewport[viewportId] ?? []
        );

        if (activeRepresentation) {
          typeToSegmentationIdMap.set(
            activeRepresentation.type,
            activeRepresentation.segmentationId
          );
        } else {
          typeToSegmentationIdMap.clear();
        }

        // Drop entries for representation types that no longer have any
        // representation on this viewport. Without this, a stale entry persists
        // (e.g. a LABELMAP entry left over when a viewport becomes a 3D/SURFACE-only
        // render). The segmentation panel reads the first matching type from this
        // map to drive the selector's controlled value, so a stale entry pins the
        // dropdown to a segmentation that isn't actually on the viewport and makes
        // switching appear broken.
        const presentTypes = new Set(representations.map(representation => representation.type));
        for (const type of Array.from(typeToSegmentationIdMap.keys())) {
          if (!presentTypes.has(type)) {
            typeToSegmentationIdMap.delete(type);
          }
        }

        setSelectedSegmentationsForViewport(viewportId, typeToSegmentationIdMap);
      })
    )
    .map(subscription => subscription.unsubscribe);

  return { unsubscribeSelectedSegmentationsForViewportEvents };
}
