import type { ImageVolume } from '../utils/extractDisplaySetVolume';
import { VERTEBRAE_LABELS } from './models/vertebrae';
import { runInWorker } from './runInWorker';

export interface LocalModelResult {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
  labelNames: Record<number, string>;
}

export interface LocalModel {
  id: string;
  name: string;
  description: string;
  modality: string;
  /** Relative URL (under window.config.aiModelsPath) for the .onnx file. */
  onnxFile: string;
  labelNames: Record<number, string>;
  run: (
    volume: ImageVolume,
    opts: { onnxUrl: string; onProgress?: (stage: string, p: number, total: number) => void }
  ) => Promise<LocalModelResult>;
}

export const LOCAL_MODELS: Record<string, LocalModel> = {
  vertebrae: {
    id: 'vertebrae',
    name: 'Vertebrae detection',
    description:
      'nnU-Net (TotalSegmentator Task252). 24 vertebra labels L5 → C1. Browser inference uses WebGPU when available.',
    modality: 'CT',
    onnxFile: 'vertebrae.onnx',
    labelNames: VERTEBRAE_LABELS,
    run: (volume, opts) =>
      runInWorker(volume, {
        modelId: 'vertebrae',
        onnxUrl: opts.onnxUrl,
        onProgress: opts.onProgress,
      }),
  },
};
