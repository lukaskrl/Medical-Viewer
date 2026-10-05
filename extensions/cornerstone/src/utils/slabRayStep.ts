import {
  CONSTANTS,
  Enums,
  eventTarget,
  getConfiguration,
  getEnabledElement,
  utilities,
  type Types,
} from '@cornerstonejs/core';
import type { mat3 } from 'gl-matrix';

const { MINIMUM_SLAB_THICKNESS } = CONSTANTS.RENDERING_DEFAULTS;

// How much coarser the ray step is while the view is changing.
const INTERACTIVE_STEP_FACTOR = 2;
// Quiet time after the last change before the full-quality frame.
const IDLE_RESTORE_MS = 200;

type VolumeMapper = {
  getInputData: () => { getSpacing(): number[]; getDirection(): ArrayLike<number> } | null;
  setSampleDistance: (sampleDistance: number) => boolean;
};

/**
 * Speeds up thick-slab (MIP, MinIP, average) rendering in MPR viewports.
 *
 * vtk.js samples every pixel along the whole slab, and Cornerstone uses one
 * ray step for every view direction: half the mean voxel spacing, 0.3 mm on a
 * 0.29 x 0.29 x 1.25 mm CT. An 80 mm slab is then ~260 samples per pixel for
 * each volume actor, which took ~250 ms a frame on an integrated GPU at
 * 3440x1440, against one 16 ms frame for a thin slice.
 *
 * At rest the step becomes half the voxel spacing along the view direction,
 * never finer than Cornerstone's own: 0.63 mm for axial on that CT, unchanged
 * for sagittal and coronal. While the camera or VOI is changing the step
 * doubles, and the full-quality frame is rendered once the view settles.
 * Actors on a thin slice keep Cornerstone's step.
 *
 * Rendering fewer pixels during interaction would save more, but vtk.js only
 * honours imageSampleDistance while its interactor animates, which
 * Cornerstone's offscreen render window never does.
 *
 * @returns a function that stops listening
 */
export function initSlabRayStep(): () => void {
  const removeListeners = new Map<HTMLDivElement, () => void>();

  const onElementEnabled = (evt: Types.EventTypes.ElementEnabledEvent) => {
    const { element } = evt.detail;
    if (removeListeners.has(element)) {
      return;
    }

    let restoreTimer: ReturnType<typeof setTimeout> | undefined;

    const onViewChanged = () => {
      const viewport = getEnabledElement(element)?.viewport as Types.IVolumeViewport;
      if (viewport?.type !== Enums.ViewportType.ORTHOGRAPHIC) {
        return;
      }

      clearTimeout(restoreTimer);
      restoreTimer = undefined;

      const isSlab = viewport.getSlabThickness() > MINIMUM_SLAB_THICKNESS;
      // Also runs on thin slices, so a removed slab gets Cornerstone's step back.
      setRayStep(viewport, isSlab);
      if (!isSlab) {
        return;
      }

      restoreTimer = setTimeout(() => {
        restoreTimer = undefined;
        if (getEnabledElement(element)?.viewport !== viewport) {
          return;
        }
        setRayStep(viewport, false);
        viewport.render();
      }, IDLE_RESTORE_MS);
    };

    element.addEventListener(Enums.Events.CAMERA_MODIFIED, onViewChanged);
    element.addEventListener(Enums.Events.VOI_MODIFIED, onViewChanged);
    removeListeners.set(element, () => {
      clearTimeout(restoreTimer);
      element.removeEventListener(Enums.Events.CAMERA_MODIFIED, onViewChanged);
      element.removeEventListener(Enums.Events.VOI_MODIFIED, onViewChanged);
    });
  };

  const onElementDisabled = (evt: Types.EventTypes.ElementDisabledEvent) => {
    const { element } = evt.detail;
    removeListeners.get(element)?.();
    removeListeners.delete(element);
  };

  eventTarget.addEventListener(Enums.Events.ELEMENT_ENABLED, onElementEnabled);
  eventTarget.addEventListener(Enums.Events.ELEMENT_DISABLED, onElementDisabled);

  return () => {
    eventTarget.removeEventListener(Enums.Events.ELEMENT_ENABLED, onElementEnabled);
    eventTarget.removeEventListener(Enums.Events.ELEMENT_DISABLED, onElementDisabled);
    removeListeners.forEach(remove => remove());
    removeListeners.clear();
  };
}

function setRayStep(viewport: Types.IVolumeViewport, interactive: boolean) {
  const { viewPlaneNormal } = viewport.getCamera();
  const multiplier = getConfiguration().rendering?.volumeRendering?.sampleDistanceMultiplier || 1;

  viewport.getActors().forEach(actorEntry => {
    if (!utilities.actorIsA(actorEntry, 'vtkVolume')) {
      return;
    }
    const mapper = actorEntry.actor.getMapper() as unknown as VolumeMapper;
    const imageData = mapper.getInputData();
    if (!imageData) {
      return;
    }

    const spacing = imageData.getSpacing() as Types.Point3;
    // Cornerstone's step, see createVolumeMapper.
    let step = (multiplier * (spacing[0] + spacing[1] + spacing[2])) / 6;

    if (actorEntry.slabThickness > MINIMUM_SLAB_THICKNESS) {
      const spacingAlongView = utilities.getSpacingInNormalDirection(
        { direction: imageData.getDirection() as mat3, spacing },
        viewPlaneNormal
      );
      step = Math.max(step, spacingAlongView / 2) * (interactive ? INTERACTIVE_STEP_FACTOR : 1);
    }

    mapper.setSampleDistance(step);
  });
}
