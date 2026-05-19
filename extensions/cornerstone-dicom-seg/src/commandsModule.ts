import dcmjs from 'dcmjs';
import { classes, Types, utils } from '@ohif/core';
import { cache, metaData } from '@cornerstonejs/core';
import { segmentation as cornerstoneToolsSegmentation } from '@cornerstonejs/tools';
import { adaptersRT, adaptersSEG } from '@cornerstonejs/adapters';
import { createReportDialogPrompt, useUIStateStore } from '@ohif/extension-default';

import PROMPT_RESPONSES from '../../default/src/utils/_shared/PROMPT_RESPONSES';
import { extractSegmentationVolume } from './utils/extractSegmentationVolume';
import { buildNiftiBuffer, gzipNifti } from './utils/niftiWriter';
import { buildNrrdBuffer } from './utils/nrrdWriter';
import type {
  OHIFSegmentation,
  OHIFSegment,
  OHIFStackLabelmapData,
} from './types/ohifSegmentation';

const { downloadBlob } = utils;

const sanitizeFilename = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'segmentation';

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

const {
  Cornerstone3D: {
    Segmentation: { generateSegmentation },
  },
} = adaptersSEG;

const {
  Cornerstone3D: {
    RTSS: { generateRTSSFromRepresentation },
  },
} = adaptersRT;


const commandsModule = ({
  servicesManager,
  extensionManager,
  commandsManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const { segmentationService, displaySetService, viewportGridService } =
    servicesManager.services as AppTypes.Services;

  const actions = {
    /**
     * Loads segmentations for a specified viewport.
     * The function prepares the viewport for rendering, then loads the segmentation details.
     * Additionally, if the segmentation has scalar data, it is set for the corresponding label map volume.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentations - Array of segmentations to be loaded.
     * @param params.viewportId - the target viewport ID.
     *
     */
    loadSegmentationsForViewport: async ({ segmentations, viewportId }) => {
      // Todo: handle adding more than one segmentation
      const viewport = getTargetViewport({ viewportId, viewportGridService });
      const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];

      const segmentation = segmentations[0];
      const segmentationId = segmentation.segmentationId;
      const label = segmentation.config.label;
      const segments = segmentation.config.segments;

      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

      await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        segments,
        label,
      });

      segmentationService.addOrUpdateSegmentation(segmentation);

      await segmentationService.addSegmentationRepresentation(viewport.viewportId, {
        segmentationId,
      });

      return segmentationId;
    },
    /**
     * Generates a segmentation from a given segmentation ID.
     * This function retrieves the associated segmentation and
     * its referenced volume, extracts label maps from the
     * segmentation volume, and produces segmentation data
     * alongside associated metadata.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be generated.
     * @param params.options - Optional configuration for the generation process.
     *
     * @returns Returns the generated segmentation data.
     */
    generateSegmentation: ({
      segmentationId,
      options = {},
    }: {
      segmentationId: string;
      options?: { predecessorImageId?: string; [key: string]: unknown };
    }) => {
      const segmentation = cornerstoneToolsSegmentation.state.getSegmentation(
        segmentationId
      ) as OHIFSegmentation;
      const predecessorImageId = options.predecessorImageId ?? segmentation.predecessorImageId;

      const labelmap = segmentation.representationData.Labelmap as OHIFStackLabelmapData;
      const { imageIds } = labelmap;

      const segImages = imageIds.map(imageId => cache.getImage(imageId));
      const referencedImages = segImages.map(image => cache.getImage(image.referencedImageId));

      const labelmaps2D = [];

      let z = 0;

      for (const segImage of segImages) {
        const segmentsOnLabelmap = new Set();
        const pixelData = segImage.getPixelData();
        const { rows, columns } = segImage;

        // Use a single pass through the pixel data
        for (let i = 0; i < pixelData.length; i++) {
          const segment = pixelData[i];
          if (segment !== 0) {
            segmentsOnLabelmap.add(segment);
          }
        }

        labelmaps2D[z++] = {
          segmentsOnLabelmap: Array.from(segmentsOnLabelmap),
          pixelData,
          rows,
          columns,
        };
      }

      const allSegmentsOnLabelmap = labelmaps2D.map(labelmap => labelmap.segmentsOnLabelmap);

      const labelmap3D = {
        segmentsOnLabelmap: Array.from(new Set(allSegmentsOnLabelmap.flat())),
        metadata: [],
        labelmaps2D,
      };

      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const representations = segmentationService.getRepresentationsForSegmentation(segmentationId);

      Object.entries(segmentationInOHIF.segments).forEach(([segmentIndex, rawSegment]) => {
        // segmentation service already has a color for each segment
        if (!rawSegment) {
          return;
        }

        const segment = rawSegment as OHIFSegment;
        const { label } = segment;

        const firstRepresentation = representations[0];
        const color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          segment.segmentIndex
        );

        const RecommendedDisplayCIELabValue = dcmjs.data.Colors.rgb2DICOMLAB(
          color.slice(0, 3).map(value => value / 255)
        ).map(value => Math.round(value));

        const segmentMetadata = {
          SegmentNumber: segmentIndex.toString(),
          SegmentLabel: label,
          SegmentAlgorithmType: segment.algorithmType || 'MANUAL',
          SegmentAlgorithmName: segment.algorithmName || 'OHIF Brush',
          RecommendedDisplayCIELabValue,
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
        };
        labelmap3D.metadata[segmentIndex] = segmentMetadata;
      });

      const generatedSegmentation = generateSegmentation(referencedImages, labelmap3D, metaData, {
        predecessorImageId,
        ...options,
      });

      return generatedSegmentation;
    },
    /**
     * Downloads a segmentation based on the provided segmentation ID.
     * This function retrieves the associated segmentation and
     * uses it to generate the corresponding DICOM dataset, which
     * is then downloaded with an appropriate filename.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be downloaded.
     *
     */
    downloadSegmentation: ({ segmentationId }) => {
      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const generatedSegmentation = actions.generateSegmentation({
        segmentationId,
      });
      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: 'download',
        defaultFileName: `${segmentationInOHIF.label}.dcm`,
      });
      storeFn(generatedSegmentation.dataset);
    },
    /**
     * Stores a segmentation based on the provided segmentationId into a specified data source.
     * The SeriesDescription is derived from user input or defaults to the segmentation label,
     * and in its absence, defaults to 'Research Derived Series'.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be stored.
     * @param params.dataSource - Data source where the generated segmentation will be stored.
     *
     * @returns {Object|void} Returns the naturalized report if successfully stored,
     * otherwise throws an error.
     */
    storeSegmentation: async ({ segmentationId, dataSource, modality = 'SEG' }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId) as
        | OHIFSegmentation
        | undefined;

      if (!segmentation) {
        throw new Error('No segmentation found');
      }

      const { label, predecessorImageId } = segmentation;

      const {
        value: reportName,
        dataSourceName,
        series,
        priorSeriesNumber,
        action,
      } = await createReportDialogPrompt({
        servicesManager,
        extensionManager,
        predecessorImageId,
        title: 'Store Segmentation',
        modality,
        enableDownload: true,
      });

      if (action !== PROMPT_RESPONSES.CREATE_REPORT) {
        return;
      }

      const defaultFileName =
        modality === 'RTSTRUCT'
          ? `rtss-${segmentationId}.dcm`
          : `${label || 'segmentation'}.dcm`;

      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: dataSourceName,
        defaultFileName,
      });

      if (!storeFn) {
        throw new Error(`No valid store for dataSource: ${dataSourceName}`);
      }

      try {
        const args = {
          segmentationId,
          options: {
            SeriesDescription: series ? undefined : reportName || label || 'Contour Series',
            SeriesNumber: series ? undefined : 1 + priorSeriesNumber,
            predecessorImageId: series,
          },
        };
        const generatedDataAsync =
          (modality === 'SEG' && actions.generateSegmentation(args)) ||
          (modality === 'RTSTRUCT' && actions.generateContour(args));
        const generatedData = await generatedDataAsync;

        if (!generatedData?.dataset) {
          throw new Error('Error during segmentation generation');
        }

        const { dataset: naturalizedReport } = generatedData;

        // DCMJS assigns a dummy study id during creation, and this can cause problems, so clearing it out
        if (naturalizedReport.StudyID === 'No Study ID') {
          naturalizedReport.StudyID = '';
        }

        await storeFn(naturalizedReport, {});

        return naturalizedReport;
      } catch (error) {
        console.debug('Error storing segmentation:', error);
        throw error;
      }
    },

    generateContour: async args => {
      const { segmentationId, options } = args;
      const segmentations = segmentationService.getSegmentation(segmentationId) as OHIFSegmentation;

      // inject colors to the segmentIndex
      const firstRepresentation =
        segmentationService.getRepresentationsForSegmentation(segmentationId)[0];
      Object.entries(segmentations.segments).forEach(([segmentIndex, segment]) => {
        (segment as OHIFSegment).color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          Number(segmentIndex)
        );
      });
      const predecessorImageId = options?.predecessorImageId ?? segmentations.predecessorImageId;
      const dataset = await generateRTSSFromRepresentation(segmentations, {
        predecessorImageId,
        ...options,
      });
      return { dataset };
    },

    /**
     * Downloads an RTSS instance from a segmentation or contour
     * representation.
     */
    downloadRTSS: async args => {
      const { dataset } = await actions.generateContour(args);
      const { InstanceNumber: instanceNumber = 1, SeriesInstanceUID: seriesUID } = dataset;
      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: 'download',
        defaultFileName: `rtss-${seriesUID}-${instanceNumber}.dcm`,
      });
      await storeFn(dataset);
    },

    /**
     * Downloads a segmentation as a NIfTI file (.nii or .nii.gz).
     *
     * Builds a 3D labelmap from the segmentation's per-slice imageIds, derives
     * geometry from the referenced source image metadata, and writes a
     * single-file NIfTI-1. The affine is written so the volume appears in
     * NIfTI's canonical RAS+ space.
     */
    downloadSegmentationNifti: ({ segmentationId, gzip = true }) => {
      const volume = extractSegmentationVolume(segmentationId);
      const niftiBuffer = buildNiftiBuffer(volume);
      const baseName = sanitizeFilename(volume.label);

      if (gzip) {
        const gz = gzipNifti(niftiBuffer);
        downloadBlob(new Blob([gz], { type: 'application/gzip' }), {
          filename: `${baseName}.nii.gz`,
        });
      } else {
        downloadBlob(new Blob([niftiBuffer], { type: 'application/octet-stream' }), {
          filename: `${baseName}.nii`,
        });
      }
    },

    /**
     * Downloads a segmentation as a NRRD file (.nrrd).
     *
     * The header records the geometry in DICOM LPS so the volume registers
     * 1:1 with the source images in tools like 3D Slicer.
     */
    downloadSegmentationNrrd: ({ segmentationId }) => {
      const volume = extractSegmentationVolume(segmentationId);
      const nrrdBuffer = buildNrrdBuffer(volume);
      const baseName = sanitizeFilename(volume.label);
      downloadBlob(new Blob([nrrdBuffer], { type: 'application/octet-stream' }), {
        filename: `${baseName}.nrrd`,
      });
    },

    toggleActiveSegmentationUtility: ({ itemId: buttonId }) => {
      const { uiState, setUIState } = useUIStateStore.getState();
      const isButtonActive = uiState['activeSegmentationUtility'] === buttonId;
      console.log('toggleActiveSegmentationUtility', isButtonActive, buttonId);
      // if the button is active, clear the active segmentation utility
      if (isButtonActive) {
        setUIState('activeSegmentationUtility', null);
      } else {
        setUIState('activeSegmentationUtility', buttonId);
      }
    },
  };

  const definitions = {
    loadSegmentationsForViewport: actions.loadSegmentationsForViewport,
    generateSegmentation: actions.generateSegmentation,
    downloadSegmentation: actions.downloadSegmentation,
    storeSegmentation: actions.storeSegmentation,
    downloadRTSS: actions.downloadRTSS,
    downloadSegmentationNifti: actions.downloadSegmentationNifti,
    downloadSegmentationNrrd: actions.downloadSegmentationNrrd,
    toggleActiveSegmentationUtility: actions.toggleActiveSegmentationUtility,
  };

  return {
    actions,
    definitions,
    defaultContext: 'SEGMENTATION',
  };
};

export default commandsModule;
