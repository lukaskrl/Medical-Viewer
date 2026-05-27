import { MIN_SEGMENTATION_DRAWING_RADIUS, MAX_SEGMENTATION_DRAWING_RADIUS } from './constants';

const colours = {
  'viewport-0': 'rgb(200, 0, 0)',
  'viewport-1': 'rgb(200, 200, 0)',
  'viewport-2': 'rgb(0, 200, 0)',
};

const colorsByOrientation = {
  axial: 'rgb(200, 0, 0)',
  sagittal: 'rgb(200, 200, 0)',
  coronal: 'rgb(0, 200, 0)',
};

function getLabelMapSegmentationTools(toolNames) {
  return [
    {
      toolName: toolNames.SegmentBidirectional,
    },
    {
      toolName: 'CircularBrush',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'FILL_INSIDE_CIRCLE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
      },
    },
    {
      toolName: toolNames.LabelmapSlicePropagation,
    },
    {
      toolName: toolNames.MarkerLabelmap,
    },
    {
      toolName: toolNames.RegionSegmentPlus,
    },
    {
      toolName: 'CircularEraser',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'ERASE_INSIDE_CIRCLE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
      },
    },
    {
      toolName: 'SphereBrush',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'FILL_INSIDE_SPHERE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
      },
    },
    {
      toolName: 'SphereEraser',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'ERASE_INSIDE_SPHERE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
      },
    },
    {
      toolName: 'ThresholdCircularBrush',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
      },
    },
    {
      toolName: 'ThresholdSphereBrush',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'THRESHOLD_INSIDE_SPHERE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
      },
    },
    {
      toolName: 'ThresholdCircularBrushDynamic',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        threshold: {
          isDynamic: true,
          dynamicRadius: 3,
        },
      },
    },
    {
      toolName: toolNames.SegmentSelect,
    },
    {
      toolName: 'ThresholdSphereBrushDynamic',
      parentTool: 'Brush',
      configuration: {
        activeStrategy: 'THRESHOLD_INSIDE_SPHERE',
        minRadius: MIN_SEGMENTATION_DRAWING_RADIUS,
        maxRadius: MAX_SEGMENTATION_DRAWING_RADIUS,
        threshold: {
          isDynamic: true,
          dynamicRadius: 3,
        },
      },
    },
    {
      toolName: toolNames.LabelMapEditWithContourTool,
    },
    { toolName: toolNames.CircleScissors },
    { toolName: toolNames.RectangleScissors },
    { toolName: toolNames.SphereScissors },
  ];
}

function getContourSegmentationTools(toolNames) {
  return [
    { toolName: toolNames.PlanarFreehandContourSegmentation },
    { toolName: toolNames.LivewireContourSegmentation },
    { toolName: toolNames.SculptorTool },
    {
      toolName: 'CatmullRomSplineROI',
      parentTool: toolNames.SplineContourSegmentation,
      configuration: {
        spline: {
          type: 'CATMULLROM',
          enableTwoPointPreview: true,
        },
      },
    },
    {
      toolName: 'LinearSplineROI',
      parentTool: toolNames.SplineContourSegmentation,
      configuration: {
        spline: {
          type: 'LINEAR',
          enableTwoPointPreview: true,
        },
      },
    },
    {
      toolName: 'BSplineROI',
      parentTool: toolNames.SplineContourSegmentation,
      configuration: {
        spline: {
          type: 'BSPLINE',
          enableTwoPointPreview: true,
        },
      },
    },
  ];
}

function initDefaultToolGroup(extensionManager, toolGroupService, commandsManager, toolGroupId) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );

  const { toolNames, Enums } = utilityModule.exports;

  const tools = {
    active: [
      {
        toolName: toolNames.WindowLevel,
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
      {
        toolName: toolNames.Pan,
        bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }],
      },
      {
        toolName: toolNames.Zoom,
        bindings: [{ mouseButton: Enums.MouseBindings.Secondary }, { numTouchPoints: 2 }],
      },
      {
        toolName: toolNames.StackScroll,
        bindings: [{ mouseButton: Enums.MouseBindings.Wheel }, { numTouchPoints: 3 }],
      },
    ],
    passive: [
      { toolName: toolNames.Length },
      {
        toolName: toolNames.ArrowAnnotate,
        configuration: {
          getTextCallback: (callback, eventDetails) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              eventDetails,
            });
          },
          changeTextCallback: (data, eventDetails, callback) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              data,
              eventDetails,
            });
          },
        },
      },
      { toolName: toolNames.Bidirectional },
      ...getLabelMapSegmentationTools(toolNames),
      ...getContourSegmentationTools(toolNames),
      { toolName: toolNames.DragProbe },
      { toolName: toolNames.Probe },
      { toolName: toolNames.EllipticalROI },
      { toolName: toolNames.CircleROI },
      { toolName: toolNames.RectangleROI },
      { toolName: toolNames.StackScroll },
      { toolName: toolNames.Angle },
      { toolName: toolNames.CobbAngle },
      { toolName: toolNames.Magnify },
      { toolName: toolNames.CalibrationLine },
      { toolName: toolNames.UltrasoundDirectional },
      { toolName: toolNames.PlanarFreehandROI },
      { toolName: toolNames.SplineROI },
      { toolName: toolNames.LivewireContour },
      { toolName: toolNames.WindowLevelRegion },
    ],
    enabled: [{ toolName: toolNames.ImageOverlayViewer }, { toolName: toolNames.ReferenceLines }],
    disabled: [
      {
        toolName: toolNames.AdvancedMagnify,
      },
    ],
  };

  const updatedTools = commandsManager.run('initializeSegmentLabelTool', { tools });

  toolGroupService.createToolGroupAndAddTools(toolGroupId, updatedTools);
}

function initSRToolGroup(extensionManager, toolGroupService) {
  const SRUtilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone-dicom-sr.utilityModule.tools'
  );

  if (!SRUtilityModule) {
    return;
  }

  const CS3DUtilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );

  const { toolNames: SRToolNames } = SRUtilityModule.exports;
  const { toolNames, Enums } = CS3DUtilityModule.exports;
  const tools = {
    active: [
      {
        toolName: toolNames.WindowLevel,
        bindings: [
          {
            mouseButton: Enums.MouseBindings.Primary,
          },
        ],
      },
      {
        toolName: toolNames.Pan,
        bindings: [
          {
            mouseButton: Enums.MouseBindings.Auxiliary,
          },
        ],
      },
      {
        toolName: toolNames.Zoom,
        bindings: [
          {
            mouseButton: Enums.MouseBindings.Secondary,
          },
          { numTouchPoints: 2 },
        ],
      },
      {
        toolName: toolNames.StackScroll,
        bindings: [{ mouseButton: Enums.MouseBindings.Wheel }, { numTouchPoints: 3 }],
      },
    ],
    passive: [
      { toolName: SRToolNames.SRLength },
      { toolName: SRToolNames.SRArrowAnnotate },
      { toolName: SRToolNames.SRBidirectional },
      { toolName: SRToolNames.SREllipticalROI },
      { toolName: SRToolNames.SRCircleROI },
      { toolName: SRToolNames.SRPlanarFreehandROI },
      { toolName: SRToolNames.SRRectangleROI },
      { toolName: toolNames.WindowLevelRegion },
    ],
    enabled: [
      {
        toolName: SRToolNames.DICOMSRDisplay,
      },
    ],
    // disabled
  };

  const toolGroupId = 'SRToolGroup';
  toolGroupService.createToolGroupAndAddTools(toolGroupId, tools);
}

function initMPRToolGroup(extensionManager, toolGroupService, commandsManager) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );

  const serviceManager = extensionManager._servicesManager;
  const { cornerstoneViewportService } = serviceManager.services;

  const { toolNames, Enums } = utilityModule.exports;

  const tools = {
    active: [
      {
        toolName: toolNames.WindowLevel,
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
      {
        toolName: toolNames.Pan,
        bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }],
      },
      {
        toolName: toolNames.Zoom,
        bindings: [{ mouseButton: Enums.MouseBindings.Secondary }, { numTouchPoints: 2 }],
      },
      {
        toolName: toolNames.StackScroll,
        bindings: [{ mouseButton: Enums.MouseBindings.Wheel }, { numTouchPoints: 3 }],
      },
    ],
    passive: [
      { toolName: toolNames.Length },
      {
        toolName: toolNames.ArrowAnnotate,
        configuration: {
          getTextCallback: (callback, eventDetails) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              eventDetails,
            });
          },
          changeTextCallback: (data, eventDetails, callback) => {
            commandsManager.runCommand('arrowTextCallback', {
              callback,
              data,
              eventDetails,
            });
          },
        },
      },
      { toolName: toolNames.Bidirectional },
      ...getLabelMapSegmentationTools(toolNames),
      ...getContourSegmentationTools(toolNames),
      { toolName: toolNames.DragProbe },
      { toolName: toolNames.Probe },
      { toolName: toolNames.EllipticalROI },
      { toolName: toolNames.CircleROI },
      { toolName: toolNames.RectangleROI },
      { toolName: toolNames.StackScroll },
      { toolName: toolNames.Angle },
      { toolName: toolNames.CobbAngle },
      { toolName: toolNames.PlanarFreehandROI },
      { toolName: toolNames.SplineROI },
      { toolName: toolNames.LivewireContour },
      { toolName: toolNames.WindowLevelRegion },
    ],
    disabled: [
      {
        toolName: toolNames.Crosshairs,
        configuration: {
          viewportIndicators: true,
          viewportIndicatorsConfig: {
            circleRadius: 5,
            xOffset: 0.95,
            yOffset: 0.05,
          },
          disableOnPassive: true,
          autoPan: {
            enabled: false,
            panSize: 10,
          },
          getReferenceLineColor: viewportId => {
            const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);
            const viewportOptions = viewportInfo?.viewportOptions;
            if (viewportOptions) {
              return (
                colours[viewportOptions.id] ||
                colorsByOrientation[viewportOptions.orientation] ||
                '#0c0'
              );
            } else {
              console.warn('missing viewport?', viewportId);
              return '#0c0';
            }
          },
        },
      },
      {
        toolName: toolNames.AdvancedMagnify,
      },
      { toolName: toolNames.ReferenceLines },
    ],
  };

  const updatedTools = commandsManager.run('initializeSegmentLabelTool', { tools });

  toolGroupService.createToolGroupAndAddTools('mpr', updatedTools);
}
function initVolume3DToolGroup(extensionManager, toolGroupService) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );

  const { toolNames, Enums } = utilityModule.exports;

  const tools = {
    active: [
      {
        toolName: toolNames.TrackballRotateTool,
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
      {
        toolName: toolNames.Zoom,
        bindings: [{ mouseButton: Enums.MouseBindings.Secondary }, { numTouchPoints: 2 }],
      },
      {
        toolName: toolNames.Pan,
        bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }, { numTouchPoints: 3 }],
      },
    ],
  };

  toolGroupService.createToolGroupAndAddTools('volume3d', tools);
}

function initToolGroups(extensionManager, toolGroupService, commandsManager) {
  initDefaultToolGroup(extensionManager, toolGroupService, commandsManager, 'default');
  initSRToolGroup(extensionManager, toolGroupService);
  initMPRToolGroup(extensionManager, toolGroupService, commandsManager);
  initVolume3DToolGroup(extensionManager, toolGroupService);
}

export default initToolGroups;
