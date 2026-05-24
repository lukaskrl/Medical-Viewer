import type { ImageVolume } from '../utils/extractDisplaySetVolume';
import type {
  WorkerOutboundMessage,
  WorkerResultMessage,
  WorkerRunMessage,
} from './inferenceWorker';
import type { AIProgressEvent } from './progress';

let workerInstance: Worker | null = null;
let workerBusy = false;

function getWorker(): Worker {
  if (workerInstance) {
    return workerInstance;
  }
  workerInstance = new Worker(new URL('./inferenceWorker.ts', import.meta.url), {
    type: 'module',
    name: 'ai-inference-worker',
  });
  return workerInstance;
}

export interface RunInWorkerOptions {
  modelId: string;
  onnxUrl: string;
  onProgress?: (event: AIProgressEvent) => void;
}

export interface WorkerInferenceResult {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
  labelNames: Record<number, string>;
}

/**
 * Run a registered model in the inference web worker.
 *
 * Transfers `volume.data.buffer` to the worker — after this call returns, the
 * caller MUST NOT read `volume.data` again. (The viewer flow uses geometry
 * fields only, not the voxel data, post-inference.)
 *
 * The worker is reused across calls but only one inference may run at a time;
 * concurrent calls are rejected to keep the protocol simple.
 */
export function runInWorker(
  volume: ImageVolume,
  opts: RunInWorkerOptions
): Promise<WorkerInferenceResult> {
  if (workerBusy) {
    return Promise.reject(new Error('Another AI inference is already in progress.'));
  }
  workerBusy = true;
  const worker = getWorker();

  return new Promise<WorkerInferenceResult>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      workerBusy = false;
    };

    const onMessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'progress':
          opts.onProgress?.(msg.event);
          break;
        case 'result': {
          cleanup();
          const r = msg as WorkerResultMessage;
          resolve({
            data: r.data,
            width: r.width,
            height: r.height,
            depth: r.depth,
            labelNames: r.labelNames,
          });
          break;
        }
        case 'error':
          cleanup();
          reject(new Error(msg.message));
          break;
      }
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'Worker crashed'));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    const runMsg: WorkerRunMessage = {
      type: 'run',
      modelId: opts.modelId,
      onnxUrl: opts.onnxUrl,
      volume,
    };
    // Transfer the voxel buffer to avoid a full copy of the CT volume.
    worker.postMessage(runMsg, [volume.data.buffer]);
  });
}
