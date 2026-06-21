import { Enums, VolumeViewport3D } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';

import { getMeasurementWorldPoint } from './getMeasurementWorldPoint';

/**
 * Renders measurement points as 3D sphere markers inside VOLUME_3D viewports.
 *
 * Cornerstone annotation tools (Probe included) only draw in 2D/slice
 * viewports via AnnotationDisplayTool — the true 3D volume render shows nothing
 * for measurements. This manager bridges that gap: it watches the measurement
 * service and, for each supported measurement, adds a vtk sphere actor at the
 * measurement's world coordinate to every 3D viewport that shares its frame of
 * reference. It also reconciles on viewport changes so markers appear when a 3D
 * viewport is opened *after* the measurements were created.
 *
 * Markers respect depth (they are occluded by tissue in front of them) and are
 * auto-sized from the volume's voxel spacing.
 *
 * The feature starts with the Probe tool; adding more point-like tools is a
 * one-line change to MARKER_TOOL_NAMES.
 */

// Tools whose measurements should be drawn as 3D markers. Single extension
// point — add more point-like tool names here to support them.
const MARKER_TOOL_NAMES = new Set(['Probe']);

const MARKER_UID_PREFIX = 'probe-3d-marker-';
// High-contrast yellow, distinct from typical grayscale CT/MR and most segments.
const MARKER_COLOR: [number, number, number] = [1, 1, 0];

// Radius is derived from the volume voxel spacing (~3 voxels) so it scales
// sensibly across studies, clamped to a reasonable mm range. Falls back to a
// fixed size when spacing is unavailable.
const RADIUS_VOXEL_FACTOR = 3;
const RADIUS_MIN_MM = 1.5;
const RADIUS_MAX_MM = 8;
const RADIUS_FALLBACK_MM = 2.5;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const markerUidFor = (measurementUid: string) => MARKER_UID_PREFIX + measurementUid;

/**
 * Builds a sphere actor centered on the given world point. The world point is
 * baked into the sphere geometry (its center) so the actor stays at the world
 * origin.
 */
function createProbeMarkerActor(
  center: [number, number, number],
  radius: number,
  rgb: [number, number, number]
) {
  const sphereSource = vtkSphereSource.newInstance({
    center,
    radius,
    phiResolution: 20,
    thetaResolution: 20,
  });

  const mapper = vtkMapper.newInstance();
  mapper.setInputConnection(sphereSource.getOutputPort());

  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setColor(rgb[0], rgb[1], rgb[2]);
  // Note: markers respect depth — no depth-test/coincident-topology override,
  // so they are occluded by the volume render in front of them by design.

  return actor;
}

const getMeasurementFrameOfReferenceUID = (measurement): string | undefined =>
  measurement?.metadata?.FrameOfReferenceUID ?? measurement?.FrameOfReferenceUID;

/**
 * Returns a finite [x, y, z] world point for the measurement, or null when the
 * measurement carries no usable point. Guards against the degenerate
 * getCenterExtent([0,0,0]) fallback for empty measurements.
 */
function getValidWorldPoint(measurement): [number, number, number] | null {
  const point = getMeasurementWorldPoint(measurement);

  if (!Array.isArray(point) || point.length < 3) {
    return null;
  }
  if (!point.every(coord => Number.isFinite(coord))) {
    return null;
  }

  const hasRealPoint =
    measurement?.points?.[0]?.length === 3 ||
    measurement?.data?.handles?.points?.[0]?.length === 3 ||
    measurement?.metadata?.planeRestriction?.point?.length === 3;

  if (!hasRealPoint && point[0] === 0 && point[1] === 0 && point[2] === 0) {
    return null;
  }

  return [point[0], point[1], point[2]];
}

/** Computes a marker radius (mm) from the viewport's volume spacing. */
function computeMarkerRadius(viewport: Types.IViewport): number {
  try {
    const actorEntry = viewport.getActors?.()[0];
    const mapper = actorEntry?.actor?.getMapper?.() as
      | { getInputData(): { getSpacing(): number[] } }
      | undefined;
    const spacing = mapper?.getInputData?.()?.getSpacing?.();

    if (Array.isArray(spacing) && spacing.length === 3) {
      const maxSpacing = Math.max(...spacing);
      if (Number.isFinite(maxSpacing) && maxSpacing > 0) {
        return clamp(RADIUS_VOXEL_FACTOR * maxSpacing, RADIUS_MIN_MM, RADIUS_MAX_MM);
      }
    }
  } catch {
    // fall through to the fixed fallback
  }

  return RADIUS_FALLBACK_MM;
}

export function initProbe3DMarkers({ servicesManager }): () => void {
  const { measurementService, cornerstoneViewportService } = servicesManager.services;

  // viewportId -> Set<measurementUid> currently drawn in that viewport.
  const markersByViewport = new Map<string, Set<string>>();

  const getTracked = (viewportId: string): Set<string> => {
    let tracked = markersByViewport.get(viewportId);
    if (!tracked) {
      tracked = new Set();
      markersByViewport.set(viewportId, tracked);
    }
    return tracked;
  };

  const forEachVolume3DViewport = (
    cb: (viewport: Types.IViewport, viewportId: string) => void
  ) => {
    for (const viewportId of cornerstoneViewportService.getViewportIds()) {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      if (!viewport) {
        continue;
      }
      const isVolume3D =
        viewport instanceof VolumeViewport3D ||
        viewport.type === Enums.ViewportType.VOLUME_3D;
      if (isVolume3D) {
        cb(viewport, viewportId);
      }
    }
  };

  // The point a measurement should be drawn at in this viewport, or null when
  // it should not be drawn here (unsupported tool, FoR mismatch, no point).
  const getDesiredPoint = (
    viewport: Types.IViewport,
    measurement
  ): [number, number, number] | null => {
    if (!MARKER_TOOL_NAMES.has(measurement?.toolName)) {
      return null;
    }
    const measurementFoR = getMeasurementFrameOfReferenceUID(measurement);
    const viewportFoR = viewport.getFrameOfReferenceUID?.();
    // Only render where the measurement's frame of reference matches, so a
    // probe from one volume never appears in another volume's render.
    if (!measurementFoR || measurementFoR !== viewportFoR) {
      return null;
    }
    return getValidWorldPoint(measurement);
  };

  /**
   * Ensures the marker for a measurement matches its desired state in a single
   * viewport. Returns true when the viewport's actors changed (caller renders).
   * When forceRecreate is false, an existing marker is left untouched (used by
   * reconciliation, where positions have not changed).
   */
  const ensureMarkerInViewport = (
    viewport: Types.IViewport,
    viewportId: string,
    measurement,
    forceRecreate: boolean
  ): boolean => {
    const uid = markerUidFor(measurement.uid);
    const tracked = getTracked(viewportId);
    const actorExists = Boolean(viewport.getActor?.(uid));
    const desiredPoint = getDesiredPoint(viewport, measurement);

    if (!desiredPoint) {
      if (actorExists) {
        viewport.removeActors([uid]);
        tracked.delete(measurement.uid);
        return true;
      }
      tracked.delete(measurement.uid);
      return false;
    }

    if (actorExists && !forceRecreate) {
      tracked.add(measurement.uid);
      return false;
    }

    if (actorExists) {
      viewport.removeActors([uid]);
    }

    const radius = computeMarkerRadius(viewport);
    const actor = createProbeMarkerActor(desiredPoint, radius, MARKER_COLOR);
    viewport.addActor({ uid, actor, referencedId: measurement.uid });
    tracked.add(measurement.uid);
    return true;
  };

  // Add/update a single measurement's marker across all 3D viewports.
  const upsertMeasurementMarker = measurement => {
    if (!measurement?.uid || !MARKER_TOOL_NAMES.has(measurement.toolName)) {
      return;
    }
    forEachVolume3DViewport((viewport, viewportId) => {
      if (ensureMarkerInViewport(viewport, viewportId, measurement, true)) {
        viewport.render();
      }
    });
  };

  // Remove a single measurement's marker from all 3D viewports.
  const removeMeasurementMarker = (measurementUid?: string) => {
    if (!measurementUid) {
      return;
    }
    const uid = markerUidFor(measurementUid);
    forEachVolume3DViewport((viewport, viewportId) => {
      if (viewport.getActor?.(uid)) {
        viewport.removeActors([uid]);
        viewport.render();
      }
      markersByViewport.get(viewportId)?.delete(measurementUid);
    });
  };

  // Remove every tracked marker from all 3D viewports.
  const removeAllMarkers = () => {
    forEachVolume3DViewport((viewport, viewportId) => {
      const tracked = markersByViewport.get(viewportId);
      if (!tracked?.size) {
        return;
      }
      const uids = [...tracked]
        .map(markerUidFor)
        .filter(uid => Boolean(viewport.getActor?.(uid)));
      if (uids.length) {
        viewport.removeActors(uids);
        viewport.render();
      }
      tracked.clear();
    });
    markersByViewport.clear();
  };

  /**
   * Re-derives the full desired marker state for every 3D viewport. This is how
   * markers appear in a 3D viewport that opened after the measurements already
   * existed (measurement events do not refire then). Idempotent and cheap:
   * adds missing markers, prunes stale ones, leaves matching ones untouched.
   */
  const reconcileAllViewports = () => {
    const measurements = (measurementService.getMeasurements() || []).filter(m =>
      MARKER_TOOL_NAMES.has(m?.toolName)
    );
    const currentUids = new Set(measurements.map(m => m.uid));

    forEachVolume3DViewport((viewport, viewportId) => {
      let changed = false;

      // Prune markers whose measurements no longer exist.
      const tracked = markersByViewport.get(viewportId);
      if (tracked) {
        for (const measurementUid of [...tracked]) {
          if (!currentUids.has(measurementUid)) {
            const uid = markerUidFor(measurementUid);
            if (viewport.getActor?.(uid)) {
              viewport.removeActors([uid]);
            }
            tracked.delete(measurementUid);
            changed = true;
          }
        }
      }

      // Ensure each current measurement has a marker (add only if missing).
      for (const measurement of measurements) {
        if (ensureMarkerInViewport(viewport, viewportId, measurement, false)) {
          changed = true;
        }
      }

      if (changed) {
        viewport.render();
      }
    });
  };

  const { EVENTS: MEASUREMENT_EVENTS } = measurementService;

  const onAddedOrUpdated = ({ measurement }) => upsertMeasurementMarker(measurement);

  const onRemoved = payload => {
    // The MEASUREMENT_REMOVED payload's `measurement` field is the UID string,
    // not an object — but tolerate an object shape just in case.
    const measurementUid =
      typeof payload?.measurement === 'string'
        ? payload.measurement
        : payload?.measurement?.uid;
    removeMeasurementMarker(measurementUid);
  };

  const subscriptions = [
    measurementService.subscribe(MEASUREMENT_EVENTS.MEASUREMENT_ADDED, onAddedOrUpdated),
    measurementService.subscribe(MEASUREMENT_EVENTS.RAW_MEASUREMENT_ADDED, onAddedOrUpdated),
    measurementService.subscribe(MEASUREMENT_EVENTS.MEASUREMENT_UPDATED, onAddedOrUpdated),
    measurementService.subscribe(MEASUREMENT_EVENTS.MEASUREMENT_REMOVED, onRemoved),
    measurementService.subscribe(MEASUREMENT_EVENTS.MEASUREMENTS_CLEARED, removeAllMarkers),
    cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_VOLUMES_CHANGED,
      reconcileAllViewports
    ),
    cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
      reconcileAllViewports
    ),
  ];

  // Draw any measurements that already exist (e.g. restored session).
  reconcileAllViewports();

  return () => {
    subscriptions.forEach(sub => sub?.unsubscribe?.());
    removeAllMarkers();
  };
}
