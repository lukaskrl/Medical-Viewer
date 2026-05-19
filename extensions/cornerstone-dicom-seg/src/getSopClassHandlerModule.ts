import { utils, Types as OhifTypes } from '@ohif/core';
import i18n from '@ohif/i18n';
import { imageLoader, metaData, eventTarget } from '@cornerstonejs/core';
import { CONSTANTS, segmentation as cstSegmentation } from '@cornerstonejs/tools';
import { adaptersSEG, Enums } from '@cornerstonejs/adapters';

import { SOPClassHandlerId } from './id';
import { dicomlabToRGB } from './utils/dicomlabToRGB';

const sopClassUids = ['1.2.840.10008.5.1.4.1.1.66.4', '1.2.840.10008.5.1.4.1.1.66.7'];

const loadPromises = {};

async function _loadNiftiSegments({ segDisplaySet, servicesManager }) {
  const referencedDisplaySet = servicesManager.services.displaySetService.getDisplaySetByUID(
    segDisplaySet.referencedDisplaySetInstanceUID
  );

  if (!referencedDisplaySet) {
    throw new Error('referencedDisplaySet is missing for SEG');
  }

  let referencedImageIds = referencedDisplaySet.imageIds;

  if (!referencedImageIds?.length) {
    referencedImageIds = referencedDisplaySet.instances?.map(instance => instance.imageId) || [];
  }

  referencedImageIds = (referencedImageIds || []).filter(
    imageId => typeof imageId === 'string' && imageId.length > 0
  );

  if (!referencedImageIds.length) {
    throw new Error('NIfTI SEG loading failed: referenced display set has no imageIds');
  }

  const segInstances = (segDisplaySet.instances || [])
    .slice()
    .sort((a, b) => (a.InstanceNumber || 0) - (b.InstanceNumber || 0));
  const segImageIds = segInstances.map(instance => instance.imageId).filter(Boolean);

  if (!segImageIds.length) {
    throw new Error('NIfTI SEG loading failed: no segmentation imageIds found');
  }

  const segImages = await Promise.all(
    segImageIds.map(imageId => imageLoader.loadAndCacheImage(imageId))
  );

  const segmentsOnLabelmap = new Set<number>();

  // Accumulators for per-segment centroids, keyed by segment index. These are
  // required for the "jump to segment" behavior in the segmentation panel; the
  // DICOM SEG path gets them from the adapter, so we compute the equivalent here.
  const centroidAccumulators = new Map<
    number,
    {
      x: number;
      y: number;
      z: number;
      worldX: number;
      worldY: number;
      worldZ: number;
      count: number;
    }
  >();

  const labelMapImages = segImages.map((image, index) => {
    const scalarData = image.voxelManager?.getScalarData?.() || image.getPixelData?.() || [];

    const referencedImageId =
      referencedImageIds[index] || referencedImageIds[referencedImageIds.length - 1];

    if (!referencedImageId) {
      throw new Error('NIfTI SEG loading failed: unable to resolve referenced imageId');
    }

    // Mutate the cached image so getReferenceVolumeForSegmentationVolume can
    // resolve the reference volume during brush/labeling operations.
    image.referencedImageId = referencedImageId;

    const imagePlaneModule = metaData.get('imagePlaneModule', referencedImageId);
    const columns = image.columns || image.width;

    for (let i = 0; i < scalarData.length; i++) {
      const segmentIndex = scalarData[i];
      if (segmentIndex > 0) {
        segmentsOnLabelmap.add(segmentIndex);

        let accumulator = centroidAccumulators.get(segmentIndex);
        if (!accumulator) {
          accumulator = { x: 0, y: 0, z: 0, worldX: 0, worldY: 0, worldZ: 0, count: 0 };
          centroidAccumulators.set(segmentIndex, accumulator);
        }

        const x = i % columns;
        const y = Math.floor(i / columns);

        accumulator.x += x;
        accumulator.y += y;
        accumulator.z += index;

        if (imagePlaneModule) {
          const {
            imagePositionPatient,
            rowCosines,
            columnCosines,
            rowPixelSpacing,
            columnPixelSpacing,
          } = imagePlaneModule;

          // P(world) = P(image) * IOP * spacing + IPP
          accumulator.worldX +=
            imagePositionPatient[0] +
            x * rowCosines[0] * columnPixelSpacing +
            y * columnCosines[0] * rowPixelSpacing;
          accumulator.worldY +=
            imagePositionPatient[1] +
            x * rowCosines[1] * columnPixelSpacing +
            y * columnCosines[1] * rowPixelSpacing;
          accumulator.worldZ +=
            imagePositionPatient[2] +
            x * rowCosines[2] * columnPixelSpacing +
            y * columnCosines[2] * rowPixelSpacing;
        }

        accumulator.count += 1;
      }
    }

    return {
      ...image,
      imageId: image.imageId,
      referencedImageId,
    };
  });

  const sortedSegmentIndices = Array.from(segmentsOnLabelmap).sort((a, b) => a - b);
  const segMetadataData = [{}];

  // Reduce the accumulators into the centroid Map shape expected by
  // SegmentationService.createSegmentationForSEGDisplaySet. That code looks up
  // centroids by the segment's position in segMetadata.data (index 0 reserved),
  // so we key the Map the same way rather than by the raw segment value.
  const centroids = new Map();

  sortedSegmentIndices.forEach((segmentIndex, idx) => {
    const accumulator = centroidAccumulators.get(segmentIndex);
    if (accumulator) {
      const { x, y, z, worldX, worldY, worldZ, count } = accumulator;
      centroids.set(idx + 1, {
        image: {
          x: Math.floor(x / count),
          y: Math.floor(y / count),
          z: Math.floor(z / count),
        },
        world: {
          x: worldX / count,
          y: worldY / count,
          z: worldZ / count,
        },
        count,
      });
    }
  });

  sortedSegmentIndices.forEach((segmentIndex, idx) => {
    segMetadataData.push({
      SegmentNumber: String(segmentIndex),
      SegmentLabel: `Segment ${segmentIndex}`,
      SegmentAlgorithmType: 'AUTOMATIC',
      SegmentAlgorithmName: 'NIfTI Import',
      SegmentedPropertyCategoryCodeSequence: {
        CodeValue: 'T-D0050',
        CodingSchemeDesignator: 'SRT',
        CodeMeaning: 'Tissue',
      },
      SegmentedPropertyTypeCodeSequence: {
        CodeValue: 'T-D0050',
        CodingSchemeDesignator: 'SRT',
        CodeMeaning: 'Tissue',
      },
      rgba: CONSTANTS.COLOR_LUT[(idx + 1) % CONSTANTS.COLOR_LUT.length],
    });
  });

  segDisplaySet.labelMapImages = labelMapImages;
  segDisplaySet.centroids = centroids;
  segDisplaySet.segMetadata = {
    data: segMetadataData,
  };
}

function _getDisplaySetsFromSeries(
  instances,
  servicesManager: AppTypes.ServicesManager,
  extensionManager
) {
  utils.sortStudyInstances(instances);

  // Choose the LAST instance in the list as the most recently created one.
  const instance = instances[instances.length - 1];

  const {
    StudyInstanceUID,
    SeriesInstanceUID,
    SOPInstanceUID,
    SeriesDescription = '',
    SeriesNumber,
    SeriesDate,
    StructureSetDate,
    SOPClassUID,
    wadoRoot,
    wadoUri,
    wadoUriRoot,
    imageId: predecessorImageId,
  } = instance;

  const isNiftiSegmentation = instances.some(instance => instance?.isNiftiSegmentation);

  const displaySet = {
    Modality: 'SEG',
    loading: false,
    isReconstructable: false,
    displaySetInstanceUID: utils.guid(),
    SeriesDescription,
    SeriesNumber,
    SeriesDate: SeriesDate || StructureSetDate || '',
    SOPInstanceUID,
    SeriesInstanceUID,
    StudyInstanceUID,
    SOPClassHandlerId,
    SOPClassUID,
    referencedImages: null,
    referencedSeriesInstanceUID: null,
    referencedDisplaySetInstanceUID: null,
    isDerivedDisplaySet: true,
    isLoaded: false,
    isHydrated: false,
    segments: {},
    sopClassUids,
    instance,
    predecessorImageId,
    instances: isNiftiSegmentation ? instances : [instance],
    wadoRoot,
    wadoUriRoot,
    wadoUri,
    isOverlayDisplaySet: true,
    label: SeriesDescription || `${i18n.t('Series')} ${SeriesNumber} - ${i18n.t('SEG')}`,
  };

  const referencedSeriesSequence = instance.ReferencedSeriesSequence;

  if (!referencedSeriesSequence) {
    console.error('ReferencedSeriesSequence is missing for the SEG');
    return;
  }

  const referencedSeries = referencedSeriesSequence[0] || referencedSeriesSequence;

  displaySet.referencedImages = instance.ReferencedSeriesSequence.ReferencedInstanceSequence;
  displaySet.referencedSeriesInstanceUID = referencedSeries.SeriesInstanceUID;
  const { displaySetService } = servicesManager.services;
  const referencedDisplaySets = displaySetService.getDisplaySetsForReferences(
    instance.ReferencedSeriesSequence
  );

  if (referencedDisplaySets?.length > 1) {
    console.warn(
      'Segmentation does not currently handle references to multiple series, defaulting to first series'
    );
  }

  const referencedDisplaySet = referencedDisplaySets[0];

  if (!referencedDisplaySet) {
    // subscribe to display sets added which means at some point it will be available
    const { unsubscribe } = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_ADDED,
      ({ displaySetsAdded }) => {
        // here we can also do a little bit of search, since sometimes DICOM SEG
        // does not contain the referenced display set uid , and we can just
        // see which of the display sets added is more similar and assign it
        // to the referencedDisplaySet
        const addedDisplaySet = displaySetsAdded[0];
        if (addedDisplaySet.SeriesInstanceUID === displaySet.referencedSeriesInstanceUID) {
          displaySet.referencedDisplaySetInstanceUID = addedDisplaySet.displaySetInstanceUID;
          displaySet.isReconstructable = addedDisplaySet.isReconstructable;
          unsubscribe();
        }
      }
    );
  } else {
    displaySet.referencedDisplaySetInstanceUID = referencedDisplaySet.displaySetInstanceUID;
    displaySet.isReconstructable = referencedDisplaySet.isReconstructable;
  }

  displaySet.load = async ({ headers }) =>
    await _load(displaySet, servicesManager, extensionManager, headers);

  return [displaySet];
}

function _load(
  segDisplaySet,
  servicesManager: AppTypes.ServicesManager,
  extensionManager,
  headers
) {
  const { SOPInstanceUID } = segDisplaySet;
  const { segmentationService } = servicesManager.services;

  if (
    (segDisplaySet.loading || segDisplaySet.isLoaded) &&
    loadPromises[SOPInstanceUID] &&
    _segmentationExists(segDisplaySet)
  ) {
    return loadPromises[SOPInstanceUID];
  }

  segDisplaySet.loading = true;

  // We don't want to fire multiple loads, so we'll wait for the first to finish
  // and also return the same promise to any other callers.
  loadPromises[SOPInstanceUID] = new Promise(async (resolve, reject) => {
    if (!segDisplaySet.segments || Object.keys(segDisplaySet.segments).length === 0) {
      try {
        if (segDisplaySet.instance?.isNiftiSegmentation) {
          await _loadNiftiSegments({
            servicesManager,
            segDisplaySet,
          });
        } else {
          await _loadSegments({
            extensionManager,
            servicesManager,
            segDisplaySet,
            headers,
          });
        }
      } catch (e) {
        segDisplaySet.loading = false;
        return reject(e);
      }
    }

    segmentationService
      .createSegmentationForSEGDisplaySet(segDisplaySet)
      .then(() => {
        segDisplaySet.loading = false;
        resolve();
      })
      .catch(error => {
        segDisplaySet.loading = false;
        reject(error);
      });
  });

  return loadPromises[SOPInstanceUID];
}

async function _loadSegments({
  extensionManager,
  servicesManager,
  segDisplaySet,
  headers,
}: withAppTypes) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.common'
  );

  const { segmentationService, uiNotificationService } = servicesManager.services;

  const { dicomLoaderService } = utilityModule.exports;
  const arrayBuffer = await dicomLoaderService.findDicomDataPromise(segDisplaySet, null, headers);

  const referencedDisplaySet = servicesManager.services.displaySetService.getDisplaySetByUID(
    segDisplaySet.referencedDisplaySetInstanceUID
  );

  if (!referencedDisplaySet) {
    throw new Error('referencedDisplaySet is missing for SEG');
  }

  let { imageIds } = referencedDisplaySet;

  if (!imageIds) {
    // try images
    const { images } = referencedDisplaySet;
    imageIds = images.map(image => image.imageId);
  }

  // Todo: what should be defaults here
  const tolerance = 0.001;
  eventTarget.addEventListener(Enums.Events.SEGMENTATION_LOAD_PROGRESS, evt => {
    const { percentComplete } = evt.detail;
    segmentationService._broadcastEvent(segmentationService.EVENTS.SEGMENT_LOADING_COMPLETE, {
      percentComplete,
    });
  });

  const results = await adaptersSEG.Cornerstone3D.Segmentation.createFromDICOMSegBuffer(
    imageIds,
    arrayBuffer,
    { metadataProvider: metaData, tolerance }
  );

  let usedRecommendedDisplayCIELabValue = true;
  results.segMetadata.data.forEach((data, i) => {
    if (i > 0) {
      data.rgba = data.RecommendedDisplayCIELabValue;

      if (data.rgba) {
        data.rgba = dicomlabToRGB(data.rgba);
      } else {
        usedRecommendedDisplayCIELabValue = false;
        data.rgba = CONSTANTS.COLOR_LUT[i % CONSTANTS.COLOR_LUT.length];
      }
    }
  });

  if (!usedRecommendedDisplayCIELabValue) {
    // Display a notification about the non-utilization of RecommendedDisplayCIELabValue
    uiNotificationService.show({
      title: 'DICOM SEG import',
      message:
        'RecommendedDisplayCIELabValue not found for one or more segments. The default color was used instead.',
      type: 'warning',
      duration: 5000,
    });
  }

  Object.assign(segDisplaySet, results);
}

function _segmentationExists(segDisplaySet) {
  return cstSegmentation.state.getSegmentation(segDisplaySet.displaySetInstanceUID);
}

function getSopClassHandlerModule(params: OhifTypes.Extensions.ExtensionParams) {
  const { servicesManager, extensionManager } = params;
  const getDisplaySetsFromSeries = instances => {
    return _getDisplaySetsFromSeries(instances, servicesManager, extensionManager);
  };

  return [
    {
      name: 'dicom-seg',
      sopClassUids,
      getDisplaySetsFromSeries,
    },
  ];
}

export default getSopClassHandlerModule;
