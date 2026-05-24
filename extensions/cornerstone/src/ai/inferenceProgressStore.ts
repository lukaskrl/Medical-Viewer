import type { AIProgressEvent } from './progress';

/**
 * Module-level store for in-flight AI inference progress.
 *
 * Lives outside any React component so that switching panels does not lose
 * the running state — the worker keeps inferring, events keep updating this
 * store, and any (re)mounting panel renders the current snapshot.
 *
 * The displayed bar (smoothed, predictive) is still owned by the panel since
 * animation only matters while something is visible.
 */

// Bar-budget layout. The panel duplicates `PCT_INFERENCE_END` for its
// rAF-side prediction; keeping the numbers here too lets the store route
// events straight into bar-percentage targets.
const PCT_EXTRACT_END = 0.05;
const PCT_PREPROCESS_END = 0.10;
const PCT_INFERENCE_END = 0.99;
const PATCH_EWMA_ALPHA = 0.3;

export const BAR_LAYOUT = {
  PCT_EXTRACT_END,
  PCT_PREPROCESS_END,
  PCT_INFERENCE_END,
};

export interface InferenceTracker {
  totalPatches: number;
  patchesDone: number;
  lastPatchAt: number;
  ewmaPatchMs: number;
  baseBarPct: number;
  endBarPct: number;
}

export interface InferenceSnapshot {
  runningModelId: string | null;
  targetPct: number;
  progressText: string;
  error: string | null;
  inference: InferenceTracker | null;
}

let state: InferenceSnapshot = {
  runningModelId: null,
  targetPct: 0,
  progressText: '',
  error: null,
  inference: null,
};

const listeners = new Set<() => void>();

function commit(next: InferenceSnapshot): void {
  state = next;
  listeners.forEach(l => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): InferenceSnapshot {
  return state;
}

export function startRun(modelId: string): void {
  commit({
    runningModelId: modelId,
    targetPct: 0,
    progressText: 'Starting…',
    error: null,
    inference: null,
  });
}

export function endRun(error?: string | null): void {
  commit({
    runningModelId: null,
    targetPct: 0,
    progressText: '',
    error: error ?? null,
    inference: null,
  });
}

export function clearError(): void {
  if (state.error === null) return;
  commit({ ...state, error: null });
}

export function setProgressText(text: string): void {
  if (state.progressText === text) return;
  commit({ ...state, progressText: text });
}

export function bumpTarget(pct: number): void {
  const next = Math.max(state.targetPct, Math.min(1, pct));
  if (next === state.targetPct) return;
  commit({ ...state, targetPct: next });
}

export function handleProgressEvent(evt: AIProgressEvent): void {
  if (evt.phase === 'preprocess') {
    const range = PCT_PREPROCESS_END - PCT_EXTRACT_END;
    const frac = evt.total > 0 ? evt.step / evt.total : 0;
    const target = Math.max(state.targetPct, PCT_EXTRACT_END + frac * range);
    commit({ ...state, targetPct: target, progressText: evt.label });
    return;
  }
  if (evt.phase === 'inference') {
    const range = PCT_INFERENCE_END - PCT_PREPROCESS_END;
    const perPatch = evt.total > 0 ? range / evt.total : 0;
    const target = Math.max(state.targetPct, PCT_PREPROCESS_END + evt.patch * perPatch);

    const now = performance.now();
    const prev = state.inference;
    let inference: InferenceTracker;
    if (!prev || prev.totalPatches !== evt.total) {
      inference = {
        totalPatches: evt.total,
        patchesDone: evt.patch,
        lastPatchAt: now,
        ewmaPatchMs: 0,
        baseBarPct: PCT_PREPROCESS_END,
        endBarPct: PCT_INFERENCE_END,
      };
    } else {
      const dt = now - prev.lastPatchAt;
      const ewma =
        prev.ewmaPatchMs > 0
          ? prev.ewmaPatchMs * (1 - PATCH_EWMA_ALPHA) + dt * PATCH_EWMA_ALPHA
          : dt;
      inference = {
        ...prev,
        patchesDone: evt.patch,
        lastPatchAt: now,
        ewmaPatchMs: ewma,
      };
    }
    commit({
      ...state,
      targetPct: target,
      progressText: `Inference patch ${evt.patch}/${evt.total}`,
      inference,
    });
    return;
  }
  if (evt.phase === 'postprocess') {
    const range = 1 - PCT_INFERENCE_END;
    const frac = evt.total > 0 ? evt.step / evt.total : 1;
    const target = Math.max(state.targetPct, PCT_INFERENCE_END + frac * range);
    commit({
      ...state,
      targetPct: target,
      progressText: evt.label,
      inference: null,
    });
  }
}
