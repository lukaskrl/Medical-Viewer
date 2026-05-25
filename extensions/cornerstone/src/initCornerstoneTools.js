import {
  AnnotationDisplayTool,
  PanTool,
  WindowLevelTool,
  SegmentBidirectionalTool,
  StackScrollTool,
  VolumeRotateTool,
  ZoomTool,
  MIPJumpToClickTool,
  LengthTool,
  RectangleROITool,
  RectangleROIThresholdTool,
  EllipticalROITool,
  CircleROITool,
  BidirectionalTool,
  ArrowAnnotateTool,
  DragProbeTool,
  ProbeTool,
  AngleTool,
  CobbAngleTool,
  MagnifyTool,
  CrosshairsTool,
  RectangleScissorsTool,
  SphereScissorsTool,
  CircleScissorsTool,
  BrushTool,
  PaintFillTool,
  init,
  addTool,
  annotation,
  ReferenceLinesTool,
  TrackballRotateTool,
  AdvancedMagnifyTool,
  UltrasoundDirectionalTool,
  UltrasoundPleuraBLineTool,
  PlanarFreehandROITool,
  PlanarFreehandContourSegmentationTool,
  SplineROITool,
  LivewireContourTool,
  OrientationMarkerTool,
  WindowLevelRegionTool,
  SegmentSelectTool,
  RegionSegmentPlusTool,
  SegmentLabelTool,
  LivewireContourSegmentationTool,
  SculptorTool,
  SplineContourSegmentationTool,
  LabelMapEditWithContourTool,
} from '@cornerstonejs/tools';
import { getEnabledElement, VolumeViewport, utilities as csUtils } from '@cornerstonejs/core';
import { LabelmapSlicePropagationTool, MarkerLabelmapTool } from '@cornerstonejs/ai';
import * as polySeg from '@cornerstonejs/polymorphic-segmentation';
import labelmapDisplay from '@cornerstonejs/tools/tools/displayTools/Labelmap/labelmapDisplay';
import { getLabelmapActorEntries } from '@cornerstonejs/tools/segmentation/helpers/getSegmentationActor';

import CalibrationLineTool from './tools/CalibrationLineTool';
import ImageOverlayViewerTool from './tools/ImageOverlayViewerTool';
import {
  throttledComputeSurfaceData,
  throttledUpdateSurfaceData,
} from './utils/throttledPolySegSurface';

const PROBE_TOOL_NAMES = new Set([ProbeTool.toolName, DragProbeTool.toolName]);
const CLOSEST_SLICE_EPSILON_MM = 1e-3;
let isProbeNearPlanePatched = false;
let isBrushRejectPreviewPatched = false;
let isLabelmapRepresentationVisibilityPatched = false;

function patchProbeNearPlaneVisibility() {
  if (isProbeNearPlanePatched) {
    return;
  }

  const originalFilter = AnnotationDisplayTool.prototype.filterInteractableAnnotationsForElement;

  /**
   * @param {HTMLDivElement} element
   * @param {Array<any>} annotations
   */
  AnnotationDisplayTool.prototype.filterInteractableAnnotationsForElement = function (
    element,
    annotations
  ) {
    const filtered = originalFilter.call(this, element, annotations);

    if (!annotations?.length) {
      return filtered;
    }

    const enabledElement = getEnabledElement(element);
    if (!enabledElement?.viewport) {
      return filtered;
    }

    const { viewport } = enabledElement;

    if (!(viewport instanceof VolumeViewport)) {
      return filtered;
    }

    const camera = viewport.getCamera?.();
    const focalPoint = camera?.focalPoint;
    const viewPlaneNormal = camera?.viewPlaneNormal;

    if (!focalPoint || !viewPlaneNormal) {
      return filtered;
    }

    const { spacingInNormalDirection } = csUtils.getTargetVolumeAndSpacingInNormalDir(
      viewport,
      camera
    );

    if (!Number.isFinite(spacingInNormalDirection) || spacingInNormalDirection <= 0) {
      return filtered;
    }

    // Keep Probe visible only on the closest slice plane for this viewport.
    const tolerance = Math.max(spacingInNormalDirection / 2 - CLOSEST_SLICE_EPSILON_MM, 0);
    const result = [...filtered];
    const existingAnnotationUIDs = new Set(filtered.map(annotation => annotation.annotationUID));

    for (const annotation of annotations) {
      if (!annotation?.isVisible || existingAnnotationUIDs.has(annotation.annotationUID)) {
        continue;
      }

      if (!PROBE_TOOL_NAMES.has(annotation?.metadata?.toolName)) {
        continue;
      }

      const handlePoint = annotation?.data?.handles?.points?.[0];
      const restrictedPoint = annotation?.metadata?.planeRestriction?.point;
      const point = handlePoint ?? restrictedPoint;

      if (!point || point.length < 3) {
        continue;
      }

      const distance = Math.abs(
        (focalPoint[0] - point[0]) * viewPlaneNormal[0] +
          (focalPoint[1] - point[1]) * viewPlaneNormal[1] +
          (focalPoint[2] - point[2]) * viewPlaneNormal[2]
      );

      if (distance <= tolerance) {
        result.push(annotation);
        existingAnnotationUIDs.add(annotation.annotationUID);
      }
    }

    return result;
  };

  isProbeNearPlanePatched = true;
}

/**
 * Short-circuits BrushTool.rejectPreview when preview mode is disabled.
 *
 * The upstream rejectPreview runs on every tool switch (via
 * `onSetToolPassive → disableCursor → rejectPreview`) once the user has
 * dragged the brush even once — because `_previewData.element` is populated
 * during normal drags, not just preview hovers. Its expensive line is
 * `applyActiveStrategyCallback(RejectPreview)`, which invokes the strategy's
 * RejectPreview composition. That composition (preview.js) walks the entire
 * segmentation voxel manager comparing each voxel against
 * `operationData.previewSegmentIndex` — when preview is off, that index is
 * undefined and the scan is pure waste. On NIfTI-sized labelmaps this is
 * 10+ seconds per switch.
 *
 * Fix: when `configuration.preview.enabled === false`, perform only the
 * cheap parts of rejectPreview (`doneEditMemo` + reset preview flags) and
 * skip the strategy callback. Behavior with preview enabled is unchanged.
 */
function patchBrushRejectPreviewWhenDisabled() {
  if (isBrushRejectPreviewPatched) {
    return;
  }

  const origRejectPreview = BrushTool.prototype.rejectPreview;
  if (typeof origRejectPreview !== 'function') {
    return;
  }

  BrushTool.prototype.rejectPreview = function patchedRejectPreview(
    element = this._previewData?.element
  ) {
    if (!element) {
      return;
    }
    if (this.configuration?.preview?.enabled !== false) {
      return origRejectPreview.call(this, element);
    }
    // Preview off: do the cheap state cleanup only, skip the full-volume scan.
    this.doneEditMemo?.();
    if (this._previewData) {
      this._previewData.preview = null;
      this._previewData.isDrag = false;
    }
  };

  isBrushRejectPreviewPatched = true;
}

/**
 * Makes the labelmap renderer respect `representation.visible` on the actor
 * itself, not just on per-segment fill opacity.
 *
 * Upstream's `_setLabelmapColorAndOpacity` sets actor visibility from
 * `(isActiveLabelmap || renderInactiveSegmentations)` and relies on
 * per-segment outline-thickness 0 + fill-opacity 0 to suppress hidden
 * segments. For the *active* labelmap with render mode = outline (or
 * fill-and-outline), the boundary persists despite thickness 0 — the eye
 * toggle hides the fill but leaves the contour drawn. Hiding the entire
 * actor when the representation is off drops both fill and boundary
 * together.
 */
function patchLabelmapRespectRepresentationVisibility() {
  if (isLabelmapRepresentationVisibilityPatched) {
    return;
  }

  const originalRender = labelmapDisplay.render;
  if (typeof originalRender !== 'function') {
    return;
  }

  labelmapDisplay.render = async function patchedRender(viewport, representation) {
    await originalRender.call(this, viewport, representation);

    if (!representation || representation.visible !== false || !viewport) {
      return;
    }

    const entries = getLabelmapActorEntries(viewport.id, representation.segmentationId);
    if (!entries?.length) {
      return;
    }

    entries.forEach(entry => {
      const actor = entry?.actor;
      if (!actor) {
        return;
      }
      actor.setVisibility(false);
      actor.modified();
    });

    viewport.render();
  };

  isLabelmapRepresentationVisibilityPatched = true;
}

export default function initCornerstoneTools() {
  patchProbeNearPlaneVisibility();
  patchBrushRejectPreviewWhenDisabled();
  patchLabelmapRespectRepresentationVisibility();

  CrosshairsTool.isAnnotation = false;
  LabelmapSlicePropagationTool.isAnnotation = false;
  MarkerLabelmapTool.isAnnotation = false;
  ReferenceLinesTool.isAnnotation = false;
  AdvancedMagnifyTool.isAnnotation = false;
  PlanarFreehandContourSegmentationTool.isAnnotation = false;

  // Wrap the polySeg namespace so we can replace BOTH computeSurfaceData and
  // updateSurfaceData with sequential implementations. The upstream versions
  // fan out one worker task per segment index in parallel, each carrying a
  // full structured-clone copy of the labelmap scalar array; that OOMs the
  // tab on labelmaps with many labels.
  //
  // updateSurfaceData is the path triggered after a 3D viewport is closed and
  // reopened: MPR's addLabelmapToElement fires SEGMENTATION_DATA_MODIFIED,
  // which wakes a debounced listener registered when the surface
  // representation was first added, which calls updateSurfaceData. Without
  // throttling that path, the tab crashes on the second 3D open.
  // See utils/throttledPolySegSurface.ts.
  const throttledPolySeg = {
    ...polySeg,
    computeSurfaceData: throttledComputeSurfaceData,
    updateSurfaceData: throttledUpdateSurfaceData,
  };

  init({
    addons: {
      polySeg: throttledPolySeg,
    },
    computeWorker: {
      autoTerminateOnIdle: {
        enabled: false,
      },
    },
  });
  addTool(PanTool);
  addTool(SegmentBidirectionalTool);
  addTool(WindowLevelTool);
  addTool(StackScrollTool);
  addTool(VolumeRotateTool);
  addTool(ZoomTool);
  addTool(ProbeTool);
  addTool(MIPJumpToClickTool);
  addTool(LengthTool);
  addTool(RectangleROITool);
  addTool(RectangleROIThresholdTool);
  addTool(EllipticalROITool);
  addTool(CircleROITool);
  addTool(BidirectionalTool);
  addTool(ArrowAnnotateTool);
  addTool(DragProbeTool);
  addTool(AngleTool);
  addTool(CobbAngleTool);
  addTool(MagnifyTool);
  addTool(CrosshairsTool);
  addTool(RectangleScissorsTool);
  addTool(SphereScissorsTool);
  addTool(CircleScissorsTool);
  addTool(BrushTool);
  addTool(PaintFillTool);
  addTool(ReferenceLinesTool);
  addTool(CalibrationLineTool);
  addTool(TrackballRotateTool);
  addTool(ImageOverlayViewerTool);
  addTool(AdvancedMagnifyTool);
  addTool(UltrasoundDirectionalTool);
  addTool(UltrasoundPleuraBLineTool);
  addTool(PlanarFreehandROITool);
  addTool(SplineROITool);
  addTool(LivewireContourTool);
  addTool(OrientationMarkerTool);
  addTool(WindowLevelRegionTool);
  addTool(PlanarFreehandContourSegmentationTool);
  addTool(SegmentSelectTool);
  addTool(SegmentLabelTool);
  addTool(LabelmapSlicePropagationTool);
  addTool(MarkerLabelmapTool);
  addTool(RegionSegmentPlusTool);
  addTool(LivewireContourSegmentationTool);
  addTool(SculptorTool);
  addTool(SplineContourSegmentationTool);
  addTool(LabelMapEditWithContourTool);
  // Modify annotation tools to use dashed lines on SR
  const annotationStyle = {
    textBoxFontSize: '15px',
    lineWidth: '1.5',
  };

  const defaultStyles = annotation.config.style.getDefaultToolStyles();
  annotation.config.style.setDefaultToolStyles({
    global: {
      ...defaultStyles.global,
      ...annotationStyle,
    },
  });
}

const toolNames = {
  Pan: PanTool.toolName,
  ArrowAnnotate: ArrowAnnotateTool.toolName,
  WindowLevel: WindowLevelTool.toolName,
  StackScroll: StackScrollTool.toolName,
  Zoom: ZoomTool.toolName,
  VolumeRotate: VolumeRotateTool.toolName,
  MipJumpToClick: MIPJumpToClickTool.toolName,
  Length: LengthTool.toolName,
  DragProbe: DragProbeTool.toolName,
  Probe: ProbeTool.toolName,
  RectangleROI: RectangleROITool.toolName,
  RectangleROIThreshold: RectangleROIThresholdTool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  CircleROI: CircleROITool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Magnify: MagnifyTool.toolName,
  Crosshairs: CrosshairsTool.toolName,
  Brush: BrushTool.toolName,
  PaintFill: PaintFillTool.toolName,
  ReferenceLines: ReferenceLinesTool.toolName,
  CalibrationLine: CalibrationLineTool.toolName,
  TrackballRotateTool: TrackballRotateTool.toolName,
  CircleScissors: CircleScissorsTool.toolName,
  RectangleScissors: RectangleScissorsTool.toolName,
  SphereScissors: SphereScissorsTool.toolName,
  ImageOverlayViewer: ImageOverlayViewerTool.toolName,
  AdvancedMagnify: AdvancedMagnifyTool.toolName,
  UltrasoundDirectional: UltrasoundDirectionalTool.toolName,
  UltrasoundAnnotation: UltrasoundPleuraBLineTool.toolName,
  SplineROI: SplineROITool.toolName,
  LivewireContour: LivewireContourTool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
  OrientationMarker: OrientationMarkerTool.toolName,
  WindowLevelRegion: WindowLevelRegionTool.toolName,
  PlanarFreehandContourSegmentation: PlanarFreehandContourSegmentationTool.toolName,
  SegmentBidirectional: SegmentBidirectionalTool.toolName,
  SegmentSelect: SegmentSelectTool.toolName,
  SegmentLabel: SegmentLabelTool.toolName,
  LabelmapSlicePropagation: LabelmapSlicePropagationTool.toolName,
  MarkerLabelmap: MarkerLabelmapTool.toolName,
  RegionSegmentPlus: RegionSegmentPlusTool.toolName,
  LivewireContourSegmentation: LivewireContourSegmentationTool.toolName,
  SculptorTool: SculptorTool.toolName,
  SplineContourSegmentation: SplineContourSegmentationTool.toolName,
  LabelMapEditWithContourTool: LabelMapEditWithContourTool.toolName,
};

export { toolNames };
