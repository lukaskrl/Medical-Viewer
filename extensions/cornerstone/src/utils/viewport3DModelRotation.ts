import { vec3, mat4 } from 'gl-matrix';
import { BaseVolumeViewport, Types as CoreTypes } from '@cornerstonejs/core';

/**
 * Continuous "tilt" animation for 3D (volume render) viewports.
 *
 * Toggling rotation on a viewport orbits its camera back and forth around the
 * view's vertical (viewUp) axis, sweeping ±{@link AMPLITUDE_DEG} degrees in a
 * smooth pendulum motion — the model appears to tilt to the left and then to
 * the right, indefinitely.
 *
 * The animation state deliberately lives at module scope (not in React) so it
 * keeps running while the toggle button is unmounted — the viewport action
 * corners unmount whenever the mouse leaves the viewport.
 */

/** How far the model tilts to each side, in degrees. */
const AMPLITUDE_DEG = 45;
/** Duration of one full left→right→center oscillation, in milliseconds. */
const PERIOD_MS = 4000;

type RotationAnimation = {
  rafId: number;
  // Baseline camera captured when the animation started; the pendulum swings
  // symmetrically around this orientation.
  basePosition: CoreTypes.Point3;
  focalPoint: CoreTypes.Point3;
  viewUp: CoreTypes.Point3;
  startTime: number;
};

const animations = new Map<string, RotationAnimation>();

/** Whether a tilt animation is currently running for the given viewport. */
export function isModelRotating(viewportId: string): boolean {
  return animations.has(viewportId);
}

/** Stops the tilt animation for the given viewport (no-op if not running). */
export function stopModelRotation(viewportId: string): void {
  const animation = animations.get(viewportId);
  if (!animation) {
    return;
  }
  cancelAnimationFrame(animation.rafId);
  animations.delete(viewportId);
}

/**
 * Starts the tilt animation for a 3D volume viewport. Returns `true` if the
 * animation was started, `false` if the viewport is not a volume viewport.
 */
export function startModelRotation(
  viewportId: string,
  cornerstoneViewportService: AppTypes.CornerstoneViewportService
): boolean {
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

  if (!(viewport instanceof BaseVolumeViewport)) {
    return false;
  }

  // Guard against a double-start leaking a requestAnimationFrame loop.
  stopModelRotation(viewportId);

  const { position, focalPoint, viewUp } = viewport.getCamera();

  const animation: RotationAnimation = {
    rafId: 0,
    basePosition: [...position] as CoreTypes.Point3,
    focalPoint: [...focalPoint] as CoreTypes.Point3,
    viewUp: [...viewUp] as CoreTypes.Point3,
    startTime: performance.now(),
  };

  const amplitudeRad = (AMPLITUDE_DEG * Math.PI) / 180;
  // Camera offset from the focal point; orbiting keeps its length (and thus the
  // zoom/clipping range) constant, so we only ever rotate this vector.
  const relative = vec3.sub(vec3.create(), animation.basePosition, animation.focalPoint);

  const tick = (now: number) => {
    // The viewport may have been torn down (layout change, study closed).
    const currentViewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!currentViewport) {
      animations.delete(viewportId);
      return;
    }

    const elapsed = now - animation.startTime;
    // Smooth sinusoidal sweep between -AMPLITUDE and +AMPLITUDE degrees.
    const angle = amplitudeRad * Math.sin((2 * Math.PI * elapsed) / PERIOD_MS);

    // Orbit the camera around the view's vertical (viewUp) axis, through the
    // focal point, keeping viewUp itself fixed.
    const rotation = mat4.identity(new Float32Array(16));
    mat4.rotate(rotation, rotation, angle, animation.viewUp);
    const rotatedRelative = vec3.transformMat4(vec3.create(), relative, rotation);
    const newPosition = vec3.add(vec3.create(), animation.focalPoint, rotatedRelative);

    currentViewport.setCamera({
      position: newPosition as unknown as CoreTypes.Point3,
      focalPoint: animation.focalPoint,
      viewUp: animation.viewUp,
    });
    currentViewport.render();

    animation.rafId = requestAnimationFrame(tick);
  };

  animation.rafId = requestAnimationFrame(tick);
  animations.set(viewportId, animation);
  return true;
}

/**
 * Toggles the tilt animation for a viewport. Returns the new state: `true` if
 * the viewport is now rotating, `false` otherwise.
 */
export function toggleModelRotation(
  viewportId: string,
  cornerstoneViewportService: AppTypes.CornerstoneViewportService
): boolean {
  if (isModelRotating(viewportId)) {
    stopModelRotation(viewportId);
    return false;
  }
  return startModelRotation(viewportId, cornerstoneViewportService);
}
