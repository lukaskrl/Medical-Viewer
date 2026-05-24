import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  buildNiftiBuffer,
  gzipNifti,
} from '@ohif/extension-cornerstone-dicom-seg/src/utils/niftiWriter';
import { extractDisplaySetVolume, type ImageVolume } from '../utils/extractDisplaySetVolume';
import { LOCAL_MODELS, type LocalModel } from '../ai/registry';
import { isWebGpuAvailable } from '../ai/ortSession';
import { loadAiSegmentation } from '../ai/loadAiSegmentation';
import * as inferenceProgress from '../ai/inferenceProgressStore';
import { BAR_LAYOUT } from '../ai/inferenceProgressStore';

const { PCT_EXTRACT_END, PCT_PREPROCESS_END, PCT_INFERENCE_END } = BAR_LAYOUT;

// Exponential smoothing time constant (ms) for displayed → target.
const SMOOTH_TAU_MS = 220;

// Predicted in-patch motion is capped so the bar never overshoots a patch.
const PATCH_PREDICT_CAP = 0.95;

type Runtime = 'local' | 'server';

interface ServerModel {
  id: string;
  name: string;
  description: string;
  modality: string;
  labelNames?: Record<string, string>;
}

interface DisplayedModel {
  id: string;
  name: string;
  description: string;
  modality: string;
  local?: LocalModel;
  server?: ServerModel;
}

interface PanelAIModelsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  servicesManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandsManager: any;
}

const RUNTIME_STORAGE_KEY = 'ai.models.runtime';

function getConfiguredServiceUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (typeof window !== 'undefined' ? (window as any).config : null) || {};
  return (config.aiServiceUrl as string) || '';
}

function getModelsBasePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (typeof window !== 'undefined' ? (window as any).config : null) || {};
  return (config.aiModelsPath as string) || '/ai-models';
}

function readRuntimePreference(): Runtime {
  try {
    const v = localStorage.getItem(RUNTIME_STORAGE_KEY);
    if (v === 'local' || v === 'server') {
      return v;
    }
  } catch {
    /* localStorage unavailable */
  }
  return 'local';
}

function writeRuntimePreference(runtime: Runtime): void {
  try {
    localStorage.setItem(RUNTIME_STORAGE_KEY, runtime);
  } catch {
    /* localStorage unavailable */
  }
}

export default function PanelAIModels({ servicesManager, commandsManager }: PanelAIModelsProps) {
  const { viewportGridService, displaySetService, uiNotificationService } = servicesManager.services;

  const webGpu = useMemo(() => isWebGpuAvailable(), []);
  const aiServiceUrl = useMemo(() => getConfiguredServiceUrl(), []);
  const aiModelsPath = useMemo(() => getModelsBasePath(), []);

  const [runtime, setRuntime] = useState<Runtime>(() => {
    const pref = readRuntimePreference();
    if (pref === 'local' && !webGpu) {
      return aiServiceUrl ? 'server' : 'local';
    }
    return pref;
  });
  const [serverModels, setServerModels] = useState<ServerModel[]>([]);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);

  // Inference progress lives in a module-level store so it survives this panel
  // unmounting (e.g. user switches to another panel). The displayed bar value
  // is local — animation only matters while we're visible — and snaps to the
  // store's current target on (re)mount so a returning user sees the bar at
  // its true position immediately.
  const progressSnapshot = useSyncExternalStore(
    inferenceProgress.subscribe,
    inferenceProgress.getSnapshot,
    inferenceProgress.getSnapshot
  );
  const runningModelId = progressSnapshot.runningModelId;
  const progressText = progressSnapshot.progressText;
  const error = progressSnapshot.error;

  const initialDisplayed = runningModelId !== null ? progressSnapshot.targetPct : 0;
  const [displayedPct, setDisplayedPct] = useState<number>(initialDisplayed);
  const displayedRef = useRef(initialDisplayed);

  useEffect(() => {
    if (runningModelId === null) {
      displayedRef.current = 0;
      setDisplayedPct(0);
      return;
    }
    // Snap to current target on (re)mount so the bar appears at its real
    // position immediately instead of replaying the easing from zero.
    const startTarget = inferenceProgress.getSnapshot().targetPct;
    displayedRef.current = startTarget;
    setDisplayedPct(startTarget);

    let lastTick = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const dt = now - lastTick;
      lastTick = now;

      // Real target from the store, possibly nudged forward by patch-time
      // prediction so the bar advances between discrete patch updates.
      const snap = inferenceProgress.getSnapshot();
      let target = snap.targetPct;
      const inf = snap.inference;
      if (inf && inf.ewmaPatchMs > 0 && inf.patchesDone < inf.totalPatches) {
        const elapsed = now - inf.lastPatchAt;
        const frac = Math.min(PATCH_PREDICT_CAP, elapsed / inf.ewmaPatchMs);
        const perPatch = (inf.endBarPct - inf.baseBarPct) / inf.totalPatches;
        const predicted = inf.baseBarPct + (inf.patchesDone + frac) * perPatch;
        if (predicted > target) target = predicted;
      }
      target = Math.min(1, target);

      const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
      let next = displayedRef.current + (target - displayedRef.current) * alpha;
      if (target - next < 0.0005) next = target; // settle exactly when close
      if (next !== displayedRef.current) {
        displayedRef.current = next;
        setDisplayedPct(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runningModelId]);

  // Fetch the server catalog once (best-effort).
  useEffect(() => {
    if (!aiServiceUrl) {
      setServerReachable(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${aiServiceUrl}/models`, { method: 'GET' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (cancelled) return;
        setServerModels(Array.isArray(json?.models) ? json.models : []);
        setServerReachable(true);
      } catch (err) {
        if (!cancelled) {
          setServerReachable(false);
        }
        console.warn('AI Models: failed to fetch /models from', aiServiceUrl, err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aiServiceUrl]);

  const persistRuntime = useCallback(
    (next: Runtime) => {
      setRuntime(next);
      writeRuntimePreference(next);
    },
    []
  );

  const models: DisplayedModel[] = useMemo(() => {
    const map = new Map<string, DisplayedModel>();
    Object.values(LOCAL_MODELS).forEach(local => {
      map.set(local.id, {
        id: local.id,
        name: local.name,
        description: local.description,
        modality: local.modality,
        local,
      });
    });
    serverModels.forEach(server => {
      const existing = map.get(server.id);
      if (existing) {
        existing.server = server;
      } else {
        map.set(server.id, {
          id: server.id,
          name: server.name,
          description: server.description,
          modality: server.modality,
          server,
        });
      }
    });
    return Array.from(map.values());
  }, [serverModels]);

  const getActiveContext = useCallback(() => {
    const { activeViewportId, viewports } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    const displaySetInstanceUID = viewport?.displaySetInstanceUIDs?.[0];
    if (!displaySetInstanceUID) {
      return null;
    }
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
    if (!displaySet) {
      return null;
    }
    return { activeViewportId, displaySet };
  }, [viewportGridService, displaySetService]);

  const runLocal = useCallback(
    async (model: DisplayedModel, displaySet: unknown, activeViewportId: string) => {
      if (!model.local) {
        throw new Error(`Model "${model.id}" is not available locally`);
      }
      const local = model.local;

      inferenceProgress.setProgressText('Extracting volume from active viewport');
      const volume: ImageVolume = await extractDisplaySetVolume(displaySet, {
        onProgress: (loaded, total) => {
          inferenceProgress.bumpTarget(total ? (loaded / total) * PCT_EXTRACT_END : 0);
        },
      });
      inferenceProgress.bumpTarget(PCT_EXTRACT_END);

      const onnxUrl = `${aiModelsPath.replace(/\/$/, '')}/${local.onnxFile}`;
      const result = await local.run(volume, {
        onnxUrl,
        onProgress: inferenceProgress.handleProgressEvent,
      });

      inferenceProgress.setProgressText('Loading segmentation into viewer');
      inferenceProgress.bumpTarget(PCT_INFERENCE_END);
      await loadAiSegmentation({
        referenceVolume: volume,
        labelmap: result,
        labelNames: result.labelNames,
        referenceDisplaySet: displaySet,
        seriesDescription: `${local.name} (local)`,
        servicesManager,
        viewportId: activeViewportId,
      });
      inferenceProgress.bumpTarget(1);
    },
    [aiModelsPath, servicesManager]
  );

  const runServer = useCallback(
    async (model: DisplayedModel, displaySet: unknown, activeViewportId: string) => {
      if (!aiServiceUrl) {
        throw new Error('aiServiceUrl is not configured');
      }

      inferenceProgress.setProgressText('Extracting volume from active viewport');
      const volume = await extractDisplaySetVolume(displaySet, {
        onProgress: (loaded, total) => {
          inferenceProgress.bumpTarget(total ? (loaded / total) * PCT_EXTRACT_END : 0);
        },
      });

      inferenceProgress.setProgressText('Packing NIfTI for upload');
      inferenceProgress.bumpTarget(0.07);
      const buffer = buildNiftiBuffer({
        data: volume.data,
        width: volume.width,
        height: volume.height,
        depth: volume.depth,
        spacing: volume.spacing,
        origin: volume.origin,
        rowDirection: volume.rowDirection,
        columnDirection: volume.columnDirection,
        sliceDirection: volume.sliceDirection,
        label: volume.label,
      });
      const gzipped = gzipNifti(buffer);
      const blob = new Blob([gzipped], { type: 'application/gzip' });
      const file = new File([blob], 'volume.nii.gz', { type: 'application/gzip' });

      inferenceProgress.setProgressText(`Uploading to ${aiServiceUrl}`);
      inferenceProgress.bumpTarget(PCT_PREPROCESS_END);
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${aiServiceUrl}/predict/${model.id}`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          detail = j?.error || j?.detail || detail;
        } catch {
          /* not JSON */
        }
        throw new Error(`Server inference failed: ${detail}`);
      }

      inferenceProgress.setProgressText('Receiving segmentation');
      inferenceProgress.bumpTarget(0.92);
      const segBlob = await res.blob();
      const labelHeader = res.headers.get('X-Label-Names') || '';
      const labelNames: Record<number, string> = {};
      labelHeader.split(',').forEach(pair => {
        const [idx, name] = pair.split(':');
        const n = Number(idx);
        if (!Number.isNaN(n) && name) {
          labelNames[n] = name;
        }
      });
      // Fall back to local model's label names if the server didn't send any
      // and we have a matching local model.
      if (!Object.keys(labelNames).length && model.local) {
        Object.assign(labelNames, model.local.labelNames);
      }

      inferenceProgress.setProgressText('Loading segmentation into viewer');
      inferenceProgress.bumpTarget(PCT_INFERENCE_END);
      // Hand the .nii.gz directly to the existing NIfTI loader.
      const niftiFile = new File([segBlob], `${model.id}_seg.nii.gz`, {
        type: 'application/gzip',
      });
      const { getNiftiSegmentationLoader } = await import('../ai/niftiSegmentationBridge');
      const loader = getNiftiSegmentationLoader();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ds = displaySet as any;
      await loader(niftiFile, {
        fileKind: 'segmentation',
        referenceStudyInstanceUID: ds.StudyInstanceUID,
        referenceSeriesInstanceUID: ds.SeriesInstanceUID,
        referenceDisplaySetInstanceUID: ds.displaySetInstanceUID,
        segmentLabels: labelNames,
        seriesDescription: `${model.name} (server)`,
      });

      // Hydrate via the existing command. Look up the new SEG display set first.
      const { displaySetService: dsService } = servicesManager.services;
      const sets = dsService.getActiveDisplaySets?.() ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs = sets.filter((s: any) => s.Modality === 'SEG' && s.isOverlayDisplaySet);
      const latest = segs[segs.length - 1];
      if (latest) {
        await commandsManager.runCommand('hydrateSecondaryDisplaySet', {
          displaySet: latest,
          viewportId: activeViewportId,
        });
      }
      inferenceProgress.bumpTarget(1);
    },
    [aiServiceUrl, servicesManager, commandsManager]
  );

  const handleRun = useCallback(
    async (model: DisplayedModel) => {
      inferenceProgress.clearError();
      const ctx = getActiveContext();
      if (!ctx) {
        inferenceProgress.endRun('No active viewport with a display set. Open a study first.');
        return;
      }
      const useLocal = runtime === 'local';
      if (useLocal && !model.local) {
        inferenceProgress.endRun(`Model "${model.name}" is not available locally.`);
        return;
      }
      if (!useLocal && !model.server) {
        inferenceProgress.endRun(`Model "${model.name}" is not available on the server.`);
        return;
      }
      if (!useLocal && !aiServiceUrl) {
        inferenceProgress.endRun('Server runtime selected but aiServiceUrl is not configured.');
        return;
      }
      inferenceProgress.startRun(model.id);
      let runError: string | null = null;
      try {
        if (useLocal) {
          await runLocal(model, ctx.displaySet, ctx.activeViewportId);
        } else {
          await runServer(model, ctx.displaySet, ctx.activeViewportId);
        }
        uiNotificationService?.show?.({
          title: 'AI Models',
          message: `${model.name} completed`,
          type: 'success',
        });
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
        uiNotificationService?.show?.({
          title: 'AI Models',
          message: `${model.name} failed: ${runError}`,
          type: 'error',
        });
      } finally {
        inferenceProgress.endRun(runError);
      }
    },
    [aiServiceUrl, getActiveContext, runLocal, runServer, runtime, uiNotificationService]
  );

  const localDisabled = !webGpu;
  const serverDisabled = !aiServiceUrl || serverReachable === false;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <style>{`
        @keyframes ai-shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
        @keyframes ai-stripes {
          0%   { background-position: 0 0; }
          100% { background-position: 28px 0; }
        }
        @keyframes ai-pulse-glow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.0); }
          50%      { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.20); }
        }
        @keyframes ai-dot-bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%           { transform: scale(1);   opacity: 1; }
        }
        .ai-progress-track {
          position: relative;
          height: 8px;
          width: 100%;
          overflow: hidden;
          border-radius: 9999px;
          background: rgba(255, 255, 255, 0.06);
        }
        .ai-progress-fill {
          position: relative;
          height: 100%;
          border-radius: 9999px;
          background-image: linear-gradient(90deg, #7f1d1d 0%, #dc2626 50%, #f87171 100%);
          background-size: 200% 100%;
          transition: width 200ms ease-out;
          overflow: hidden;
        }
        .ai-progress-fill::after {
          content: "";
          position: absolute;
          inset: 0;
          background-image: linear-gradient(
            45deg,
            rgba(255, 255, 255, 0.18) 25%,
            transparent       25%,
            transparent       50%,
            rgba(255, 255, 255, 0.18) 50%,
            rgba(255, 255, 255, 0.18) 75%,
            transparent       75%,
            transparent
          );
          background-size: 14px 14px;
          animation: ai-stripes 0.8s linear infinite;
          opacity: 0.55;
        }
        .ai-progress-shimmer {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255, 255, 255, 0.35) 50%,
            transparent 100%
          );
          animation: ai-shimmer 1.6s linear infinite;
          pointer-events: none;
        }
        .ai-running-card {
          animation: ai-pulse-glow 2.2s ease-in-out infinite;
          border-color: rgba(239, 68, 68, 0.55) !important;
        }
        .ai-dot {
          width: 4px;
          height: 4px;
          border-radius: 9999px;
          background: currentColor;
          display: inline-block;
          animation: ai-dot-bounce 1.2s infinite ease-in-out both;
        }
        .ai-dot:nth-child(2) { animation-delay: 0.15s; }
        .ai-dot:nth-child(3) { animation-delay: 0.30s; }
      `}</style>
      <div className="border-b border-border p-3 space-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight text-foreground">AI Models</p>
          <p className="text-[10px] leading-tight text-muted-foreground">
            Segmentation & inference
          </p>
        </div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground pt-1">Inference runtime</p>
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            disabled={localDisabled}
            onClick={() => persistRuntime('local')}
            className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
              runtime === 'local'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            } ${localDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
            title={localDisabled ? 'WebGPU not available in this browser' : 'Run on this computer'}
          >
            On this computer
          </button>
          <button
            type="button"
            disabled={serverDisabled}
            onClick={() => persistRuntime('server')}
            className={`flex-1 border-l border-border px-3 py-1.5 text-xs font-medium transition-colors ${
              runtime === 'server'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            } ${serverDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
            title={
              !aiServiceUrl
                ? 'aiServiceUrl is not configured'
                : serverReachable === false
                  ? `Cannot reach ${aiServiceUrl}`
                  : 'Run on AI server'
            }
          >
            On AI server
          </button>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {runtime === 'local'
            ? webGpu
              ? 'Inference will run in your browser using WebGPU. No data leaves this machine.'
              : 'WebGPU is not available — switch to On AI server, or use a Chromium/Edge browser.'
            : aiServiceUrl
              ? `Uploads the active volume to ${aiServiceUrl}.`
              : 'Set aiServiceUrl in window.config to enable server inference.'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {models.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-8">
            No models available. Make sure either the AI service is reachable or the local ONNX
            model has been exported.
          </div>
        )}
        {models.map(model => {
          const isRunning = runningModelId === model.id;
          const disabled =
            runningModelId !== null ||
            (runtime === 'local' ? !model.local || localDisabled : !model.server || serverDisabled);
          return (
            <div
              key={model.id}
              className={`rounded-lg border border-border bg-muted/40 p-3 space-y-2 ${
                isRunning ? 'ai-running-card' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{model.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Modality: {model.modality} · {model.local ? 'local ready' : 'local —'} ·{' '}
                    {model.server ? 'server ready' : 'server —'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => handleRun(model)}
                  className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isRunning ? 'Running…' : 'Run'}
                </button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{model.description}</p>
              {isRunning && (
                <div className="space-y-1.5 pt-1">
                  <div className="ai-progress-track">
                    <div
                      className="ai-progress-fill"
                      style={{ width: `${Math.max(4, Math.round(displayedPct * 100))}%` }}
                    >
                      <span className="ai-progress-shimmer" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="inline-flex items-center gap-0.5 text-red-400">
                        <span className="ai-dot" />
                        <span className="ai-dot" />
                        <span className="ai-dot" />
                      </span>
                      <span className="truncate">{progressText || 'Working…'}</span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-foreground/80">
                      {Math.round(displayedPct * 100)}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mx-3 mb-3 rounded bg-destructive/20 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
