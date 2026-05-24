import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildNiftiBuffer,
  gzipNifti,
} from '@ohif/extension-cornerstone-dicom-seg/src/utils/niftiWriter';
import { extractDisplaySetVolume, type ImageVolume } from '../utils/extractDisplaySetVolume';
import { LOCAL_MODELS, type LocalModel } from '../ai/registry';
import { isWebGpuAvailable } from '../ai/ortSession';
import { loadAiSegmentation } from '../ai/loadAiSegmentation';

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
  const [runningModelId, setRunningModelId] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string>('');
  const [progressPct, setProgressPct] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

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

      setProgressText('Extracting volume from active viewport');
      setProgressPct(0);
      const volume: ImageVolume = await extractDisplaySetVolume(displaySet, {
        onProgress: (loaded, total) => {
          setProgressPct(total ? (loaded / total) * 0.1 : 0);
        },
      });

      const onnxUrl = `${aiModelsPath.replace(/\/$/, '')}/${local.onnxFile}`;
      const result = await local.run(volume, {
        onnxUrl,
        onProgress: (stage, p, total) => {
          setProgressText(stage);
          setProgressPct(total ? 0.1 + 0.85 * (p / total) : 0.1);
        },
      });

      setProgressText('Loading segmentation into viewer');
      setProgressPct(0.97);
      await loadAiSegmentation({
        referenceVolume: volume,
        labelmap: result,
        labelNames: result.labelNames,
        referenceDisplaySet: displaySet,
        seriesDescription: `${local.name} (local)`,
        servicesManager,
        viewportId: activeViewportId,
      });
      setProgressPct(1);
    },
    [aiModelsPath, servicesManager]
  );

  const runServer = useCallback(
    async (model: DisplayedModel, displaySet: unknown, activeViewportId: string) => {
      if (!aiServiceUrl) {
        throw new Error('aiServiceUrl is not configured');
      }

      setProgressText('Extracting volume from active viewport');
      setProgressPct(0);
      const volume = await extractDisplaySetVolume(displaySet, {
        onProgress: (loaded, total) => {
          setProgressPct(total ? (loaded / total) * 0.2 : 0);
        },
      });

      setProgressText('Packing NIfTI for upload');
      setProgressPct(0.25);
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

      setProgressText(`Uploading to ${aiServiceUrl}`);
      setProgressPct(0.3);
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

      setProgressText('Receiving segmentation');
      setProgressPct(0.85);
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

      setProgressText('Loading segmentation into viewer');
      setProgressPct(0.95);
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
      setProgressPct(1);
    },
    [aiServiceUrl, servicesManager, commandsManager]
  );

  const handleRun = useCallback(
    async (model: DisplayedModel) => {
      setError(null);
      const ctx = getActiveContext();
      if (!ctx) {
        setError('No active viewport with a display set. Open a study first.');
        return;
      }
      const useLocal = runtime === 'local';
      if (useLocal && !model.local) {
        setError(`Model "${model.name}" is not available locally.`);
        return;
      }
      if (!useLocal && !model.server) {
        setError(`Model "${model.name}" is not available on the server.`);
        return;
      }
      if (!useLocal && !aiServiceUrl) {
        setError('Server runtime selected but aiServiceUrl is not configured.');
        return;
      }
      setRunningModelId(model.id);
      setProgressPct(0);
      setProgressText('Starting…');
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
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        uiNotificationService?.show?.({
          title: 'AI Models',
          message: `${model.name} failed: ${msg}`,
          type: 'error',
        });
      } finally {
        setRunningModelId(null);
      }
    },
    [aiServiceUrl, getActiveContext, runLocal, runServer, runtime, uiNotificationService]
  );

  const localDisabled = !webGpu;
  const serverDisabled = !aiServiceUrl || serverReachable === false;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="border-b border-border p-3 space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Inference runtime</p>
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
              className="rounded-lg border border-border bg-muted/40 p-3 space-y-2"
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
                <div className="space-y-1">
                  <div className="h-1 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-primary transition-all duration-200"
                      style={{ width: `${Math.round(progressPct * 100)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">{progressText}</p>
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
