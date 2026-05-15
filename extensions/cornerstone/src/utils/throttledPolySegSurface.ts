import {
  cache,
  eventTarget,
  geometryLoader,
  getWebWorkerManager,
  triggerEvent,
  Enums as csEnums,
  Types as csTypes,
  utilities as csUtilities,
} from '@cornerstonejs/core';
import {
  Enums as csToolsEnums,
  segmentation as cstSegmentation,
  utilities as cstUtilities,
} from '@cornerstonejs/tools';

const { WorkerTypes } = csToolsEnums;
const { getUniqueSegmentIndices } = cstUtilities.segmentation;
const { getSegmentation } = cstSegmentation.state;
const { getSegmentIndexColor } = cstSegmentation.config.color;
const { transformIndexToWorld } = csUtilities;

type ComputeSurfaceOptions = {
  viewport?: { id: string };
  segmentIndices?: number[];
  [key: string]: unknown;
};

type RawSurface = {
  points: Float32Array | number[];
  polys: Uint32Array | number[];
};

type Bbox = { iMin: number; iMax: number; jMin: number; jMax: number; kMin: number; kMax: number };

// Flip to false (or gate on an env flag) once we're done diagnosing the
// multi-label 3D surface crash.
const DEBUG = true;
const LOG_TAG = '[polySeg-surface]';

type AnyTypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

// Coalesces concurrent computeSurfaceData calls for the same segmentation.
// surfaceDisplay.render in cornerstone-tools doesn't dedupe — every render
// pass between a representation add and the first compute completing kicks
// off a fresh compute. We saw 4× redundant runs in the wild even for a single
// segment (see throttledPolySegSurface debug log dated 2026-05). With many
// segments the duplication is multiplicative and OOMs the tab.
const inFlightSurfaceComputes = new Map<
  string,
  Promise<{ geometryIds: Map<number, string> }>
>();

// Drop-in replacement for @cornerstonejs/polymorphic-segmentation's
// computeSurfaceData. The upstream version fires one worker task per segment
// index in parallel (Promise.allSettled). Each task carries a full copy of the
// labelmap scalar array, so memory usage scales with N_segments × volume_size
// and OOMs the tab when there are many labels.
//
// This version:
//   1. Coalesces concurrent calls for the same segmentation.
//   2. Processes segments sequentially — only one structured-clone copy of
//      scalar data is alive at a time.
//   3. Extracts a bounding-box sub-volume per segment so each worker call
//      carries 5–10 % of the full volume instead of all of it. The WASM
//      marching-cubes step also does proportionally less work.
export async function throttledComputeSurfaceData(
  segmentationId: string,
  options: ComputeSurfaceOptions
) {
  const existing = inFlightSurfaceComputes.get(segmentationId);
  if (existing) {
    if (DEBUG) {
      console.log(
        `${LOG_TAG} coalescing concurrent computeSurfaceData call for segmentation ${segmentationId}`
      );
    }
    return existing;
  }

  const promise = computeSurfaceDataInternal(segmentationId, options);
  inFlightSurfaceComputes.set(segmentationId, promise);
  try {
    return await promise;
  } finally {
    inFlightSurfaceComputes.delete(segmentationId);
  }
}

async function computeSurfaceDataInternal(
  segmentationId: string,
  options: ComputeSurfaceOptions
) {
  const segmentation = getSegmentation(segmentationId);
  const labelmapData = segmentation?.representationData?.Labelmap as
    | { volumeId?: string; imageIds?: string[] }
    | undefined;

  if (!labelmapData?.volumeId) {
    throw new Error(
      'throttledComputeSurfaceData: only volume-backed labelmaps are supported. ' +
        'Convert stack labelmaps to volume before requesting a surface.'
    );
  }

  const volume = cache.getVolume(labelmapData.volumeId);
  if (!volume) {
    throw new Error(
      `throttledComputeSurfaceData: labelmap volume ${labelmapData.volumeId} not in cache`
    );
  }

  const viewportId = options.viewport?.id;
  if (!viewportId) {
    throw new Error('throttledComputeSurfaceData: options.viewport.id is required');
  }

  const tTotalStart = now();
  const segmentIndices = options.segmentIndices?.length
    ? options.segmentIndices
    : getUniqueSegmentIndices(segmentationId);

  const tScalarStart = now();
  const scalarData = volume.voxelManager.getCompleteScalarDataArray() as AnyTypedArray;
  const tScalarEnd = now();
  const { dimensions, spacing, direction, imageData } = volume;
  const fullVoxelCount = dimensions[0] * dimensions[1] * dimensions[2];
  const fullByteCount = scalarData.byteLength;
  const memBaseline = memSnapshot();

  if (DEBUG) {
    console.group(`${LOG_TAG} computeSurfaceData — start`);
    console.log('segmentation', segmentationId, 'viewport', viewportId);
    console.log('segments requested', segmentIndices.length, segmentIndices);
    console.log(
      'volume dimensions',
      Array.from(dimensions as unknown as number[]),
      'spacing',
      Array.from(spacing as unknown as number[]),
      'dtype',
      scalarData.constructor.name,
      'voxels',
      fullVoxelCount.toLocaleString(),
      'bytes',
      fmtBytes(fullByteCount)
    );
    console.log('scalarData materialization', fmtMs(tScalarEnd - tScalarStart));
    console.log('memory at start', fmtMem(memBaseline));
  }

  // Single pass over the labelmap to collect each segment's IJK bbox. Avoids
  // having to scan the full volume once per segment.
  const tBboxStart = now();
  const bboxes = computeSegmentBboxes(scalarData, dimensions, segmentIndices);
  const tBboxEnd = now();
  if (DEBUG) {
    const sizes = Array.from(bboxes.values()).map(bb => bboxVoxelCount(bb));
    sizes.sort((a, b) => a - b);
    const totalBboxVoxels = sizes.reduce((s, v) => s + v, 0);
    console.log(
      'bbox pass',
      fmtMs(tBboxEnd - tBboxStart),
      '— segments found',
      bboxes.size,
      '/ requested',
      segmentIndices.length,
      '— min',
      sizes[0]?.toLocaleString(),
      'median',
      sizes[Math.floor(sizes.length / 2)]?.toLocaleString(),
      'max',
      sizes[sizes.length - 1]?.toLocaleString(),
      'voxels — bbox sum / volume',
      ((totalBboxVoxels / fullVoxelCount) * 100).toFixed(1) + '%'
    );
    console.log('memory after bbox', fmtMem(memSnapshot()));
  }

  const workerManager = getWebWorkerManager();
  const geometryIds = new Map<number, string>();
  const perSegmentStats: Array<{
    segmentIndex: number;
    extractMs: number;
    workerMs: number;
    cacheMs: number;
    subVoxels: number;
    subBytes: number;
    points: number;
    polys: number;
  }> = [];

  for (const segmentIndex of segmentIndices) {
    const bbox = bboxes.get(segmentIndex);
    if (!bbox) {
      if (DEBUG) console.warn(`${LOG_TAG} segment ${segmentIndex} not found in volume — skipping`);
      continue;
    }

    // Pad the bbox by one voxel on each side so marching-cubes sees background
    // voxels surrounding the segment and produces a closed surface at the edges.
    const iMin = Math.max(0, bbox.iMin - 1);
    const jMin = Math.max(0, bbox.jMin - 1);
    const kMin = Math.max(0, bbox.kMin - 1);
    const iMax = Math.min(dimensions[0] - 1, bbox.iMax + 1);
    const jMax = Math.min(dimensions[1] - 1, bbox.jMax + 1);
    const kMax = Math.min(dimensions[2] - 1, bbox.kMax + 1);

    const subDimensions: [number, number, number] = [
      iMax - iMin + 1,
      jMax - jMin + 1,
      kMax - kMin + 1,
    ];
    const subVoxels = subDimensions[0] * subDimensions[1] * subDimensions[2];

    const tExtractStart = now();
    const subScalarData = extractSubvolume(
      scalarData,
      dimensions,
      [iMin, jMin, kMin],
      subDimensions
    );
    const tExtractEnd = now();
    const subOrigin = transformIndexToWorld(imageData, [iMin, jMin, kMin]) as [
      number,
      number,
      number,
    ];

    if (DEBUG) {
      console.group(
        `${LOG_TAG} segment ${segmentIndex} — bbox ${subDimensions.join('×')} (${subVoxels.toLocaleString()} voxels, ${fmtBytes(subScalarData.byteLength)}, ${((subVoxels / fullVoxelCount) * 100).toFixed(2)}% of volume)`
      );
      console.log(
        'subvolume IJK',
        [iMin, jMin, kMin],
        '→',
        [iMax, jMax, kMax],
        '— origin shift',
        subOrigin
      );
      console.log('extractSubvolume', fmtMs(tExtractEnd - tExtractStart));
      console.log('memory before worker', fmtMem(memSnapshot()));
    }

    triggerWorkerProgress(0, segmentIndex);

    const tWorkerStart = now();
    let rawSurface: RawSurface;
    try {
      rawSurface = (await workerManager.executeTask(
        'polySeg',
        'convertLabelmapToSurface',
        {
          scalarData: subScalarData,
          dimensions: subDimensions,
          spacing,
          origin: subOrigin,
          direction,
          segmentIndex,
        },
        {
          callbacks: [progress => triggerWorkerProgress(progress, segmentIndex)],
        }
      )) as RawSurface;
    } catch (error) {
      console.error(
        `${LOG_TAG} segment ${segmentIndex} worker failed after ${fmtMs(now() - tWorkerStart)}`,
        error
      );
      triggerWorkerProgress(100, segmentIndex);
      if (DEBUG) console.groupEnd();
      continue;
    }
    const tWorkerEnd = now();

    triggerWorkerProgress(100, segmentIndex);

    if (!rawSurface?.points || !rawSurface.polys) {
      if (DEBUG) {
        console.warn(`${LOG_TAG} segment ${segmentIndex} produced empty surface`);
        console.groupEnd();
      }
      continue;
    }

    const color = getSegmentIndexColor(viewportId, segmentationId, segmentIndex)?.slice(0, 3);
    if (!color) {
      console.warn(`${LOG_TAG} no color for segment ${segmentIndex}, skipping`);
      if (DEBUG) console.groupEnd();
      continue;
    }

    const pointsLen = (rawSurface.points as ArrayLike<number>).length;
    const polysLen = (rawSurface.polys as ArrayLike<number>).length;

    const geometryId = `segmentation_${segmentationId}_surface_${segmentIndex}`;
    const closedSurface: csTypes.PublicSurfaceData = {
      id: geometryId,
      color: color as csTypes.Point3,
      frameOfReferenceUID: 'test-frameOfReferenceUID',
      points: rawSurface.points as unknown as number[],
      polys: rawSurface.polys as unknown as number[],
      segmentIndex,
    };

    const tCacheStart = now();
    await geometryLoader.createAndCacheGeometry(geometryId, {
      type: csEnums.GeometryType.SURFACE,
      geometryData: closedSurface,
    });
    const tCacheEnd = now();

    geometryIds.set(segmentIndex, geometryId);

    if (DEBUG) {
      console.log(
        'worker',
        fmtMs(tWorkerEnd - tWorkerStart),
        '— cache',
        fmtMs(tCacheEnd - tCacheStart),
        '— points',
        (pointsLen / 3).toLocaleString(),
        '— polys',
        polysLen.toLocaleString()
      );
      console.log('memory after segment', fmtMem(memSnapshot()));
      console.groupEnd();

      perSegmentStats.push({
        segmentIndex,
        extractMs: tExtractEnd - tExtractStart,
        workerMs: tWorkerEnd - tWorkerStart,
        cacheMs: tCacheEnd - tCacheStart,
        subVoxels,
        subBytes: subScalarData.byteLength,
        points: pointsLen / 3,
        polys: polysLen,
      });
    }
  }

  if (DEBUG) {
    const tTotalEnd = now();
    const memEnd = memSnapshot();
    console.group(`${LOG_TAG} computeSurfaceData — done in ${fmtMs(tTotalEnd - tTotalStart)}`);
    console.log('segments rendered', geometryIds.size, '/', segmentIndices.length);
    console.log(
      'memory delta',
      memBaseline && memEnd
        ? `${fmtBytes(memEnd.used - memBaseline.used)} used, ${fmtBytes(memEnd.total - memBaseline.total)} total`
        : 'n/a'
    );
    if (perSegmentStats.length) {
      console.table(
        perSegmentStats.map(s => ({
          seg: s.segmentIndex,
          subBbox: s.subVoxels.toLocaleString(),
          subBytes: fmtBytes(s.subBytes),
          extractMs: s.extractMs.toFixed(1),
          workerMs: s.workerMs.toFixed(1),
          cacheMs: s.cacheMs.toFixed(1),
          points: s.points.toLocaleString(),
          polys: s.polys.toLocaleString(),
        }))
      );
    }
    console.groupEnd();
  }

  return { geometryIds };
}

// Single pass over the labelmap; returns the IJK bbox of each requested
// segment index. Indices not present in the volume are absent from the map.
function computeSegmentBboxes(
  scalarData: AnyTypedArray,
  dimensions: number[] | [number, number, number],
  segmentIndices: number[]
): Map<number, Bbox> {
  const [dx, dy, dz] = dimensions;
  const wanted = new Set(segmentIndices);
  const bboxes = new Map<number, Bbox>();

  let offset = 0;
  for (let k = 0; k < dz; k++) {
    for (let j = 0; j < dy; j++) {
      for (let i = 0; i < dx; i++, offset++) {
        const v = scalarData[offset];
        if (v === 0 || !wanted.has(v as number)) {
          continue;
        }
        const bb = bboxes.get(v as number);
        if (!bb) {
          bboxes.set(v as number, { iMin: i, iMax: i, jMin: j, jMax: j, kMin: k, kMax: k });
        } else {
          if (i < bb.iMin) bb.iMin = i;
          else if (i > bb.iMax) bb.iMax = i;
          if (j < bb.jMin) bb.jMin = j;
          else if (j > bb.jMax) bb.jMax = j;
          if (k < bb.kMin) bb.kMin = k;
          else if (k > bb.kMax) bb.kMax = k;
        }
      }
    }
  }

  return bboxes;
}

// Copy a 3D bbox of voxels from the full scalar array into a fresh typed array
// of the same dtype. We keep the original values (not a binary mask) because
// the WASM marching-cubes filters by segmentIndex internally and we'd otherwise
// have to remap; copying as-is also lets multiple nearby segments share bbox
// space without conflict.
function extractSubvolume(
  scalarData: AnyTypedArray,
  fullDimensions: number[] | [number, number, number],
  ijkMin: [number, number, number],
  subDimensions: [number, number, number]
): AnyTypedArray {
  const [dx] = fullDimensions;
  const dxy = fullDimensions[0] * fullDimensions[1];
  const [subDx, subDy, subDz] = subDimensions;
  const subDxy = subDx * subDy;

  const ctor = scalarData.constructor as new (length: number) => AnyTypedArray;
  const out = new ctor(subDx * subDy * subDz);

  const [iMin, jMin, kMin] = ijkMin;
  for (let kk = 0; kk < subDz; kk++) {
    const srcKBase = (kMin + kk) * dxy;
    const dstKBase = kk * subDxy;
    for (let jj = 0; jj < subDy; jj++) {
      const srcRow = srcKBase + (jMin + jj) * dx + iMin;
      const dstRow = dstKBase + jj * subDx;
      out.set(scalarData.subarray(srcRow, srcRow + subDx) as unknown as ArrayLike<number>, dstRow);
    }
  }

  return out;
}

function triggerWorkerProgress(progress: number, id: number) {
  triggerEvent(eventTarget, csEnums.Events.WEB_WORKER_PROGRESS, {
    progress,
    type: WorkerTypes.POLYSEG_LABELMAP_TO_SURFACE,
    id,
  });
}

function bboxVoxelCount(bb: Bbox): number {
  return (bb.iMax - bb.iMin + 1) * (bb.jMax - bb.jMin + 1) * (bb.kMax - bb.kMin + 1);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(1)} ms`;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes}`;
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

type MemSnap = { used: number; total: number; limit: number };

type ChromiumMemory = {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

// performance.memory is Chromium-only and may be undefined under cross-origin
// isolation rules. Returning undefined makes the logger gracefully degrade.
function memSnapshot(): MemSnap | undefined {
  const mem = (globalThis as { performance?: { memory?: ChromiumMemory } }).performance?.memory;
  if (!mem) return undefined;
  return {
    used: mem.usedJSHeapSize ?? 0,
    total: mem.totalJSHeapSize ?? 0,
    limit: mem.jsHeapSizeLimit ?? 0,
  };
}

function fmtMem(snap: MemSnap | undefined): string {
  if (!snap) return 'n/a (performance.memory unavailable)';
  return `${fmtBytes(snap.used)} used / ${fmtBytes(snap.total)} total / ${fmtBytes(snap.limit)} limit`;
}
