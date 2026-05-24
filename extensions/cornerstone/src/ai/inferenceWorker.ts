/// <reference lib="webworker" />

import type { ImageVolume } from '../utils/extractDisplaySetVolume';
import { runVertebraeInference } from './models/vertebrae';

export type WorkerRunMessage = {
  type: 'run';
  modelId: string;
  onnxUrl: string;
  volume: ImageVolume;
};

export type WorkerProgressMessage = {
  type: 'progress';
  stage: string;
  progress: number;
  total: number;
};

export type WorkerResultMessage = {
  type: 'result';
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
  labelNames: Record<number, string>;
};

export type WorkerErrorMessage = {
  type: 'error';
  message: string;
};

export type WorkerOutboundMessage =
  | WorkerProgressMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', async (event: MessageEvent<WorkerRunMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'run') {
    return;
  }
  const { modelId, onnxUrl, volume } = msg;
  try {
    let result;
    if (modelId === 'vertebrae') {
      result = await runVertebraeInference(volume, {
        onnxUrl,
        onProgress: (stage, progress, total) => {
          const progressMsg: WorkerProgressMessage = {
            type: 'progress',
            stage,
            progress,
            total,
          };
          scope.postMessage(progressMsg);
        },
      });
    } else {
      throw new Error(`Unknown model id in worker: ${modelId}`);
    }
    const resultMsg: WorkerResultMessage = {
      type: 'result',
      data: result.data,
      width: result.width,
      height: result.height,
      depth: result.depth,
      labelNames: result.labelNames,
    };
    scope.postMessage(resultMsg, [result.data.buffer]);
  } catch (err) {
    const errorMsg: WorkerErrorMessage = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    scope.postMessage(errorMsg);
  }
});
