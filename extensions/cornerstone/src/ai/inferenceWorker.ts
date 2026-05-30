/// <reference lib="webworker" />

import type { ImageVolume } from '../utils/extractDisplaySetVolume';
import {
  runVertebraeInference,
  CT_CONFIG,
  MRI_CONFIG,
  type VertebraeModelConfig,
} from './models/vertebrae';
import type { AIProgressEvent } from './progress';

export type WorkerRunMessage = {
  type: 'run';
  modelId: string;
  onnxUrl: string;
  volume: ImageVolume;
};

export type WorkerProgressMessage = {
  type: 'progress';
  event: AIProgressEvent;
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
    const configByModelId: Record<string, VertebraeModelConfig> = {
      vertebrae_ct: CT_CONFIG,
      vertebrae_mri: MRI_CONFIG,
    };
    const config = configByModelId[modelId];
    if (!config) {
      throw new Error(`Unknown model id in worker: ${modelId}`);
    }
    const result = await runVertebraeInference(
      volume,
      {
        onnxUrl,
        onProgress: event => {
          const progressMsg: WorkerProgressMessage = { type: 'progress', event };
          scope.postMessage(progressMsg);
        },
      },
      config
    );
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
