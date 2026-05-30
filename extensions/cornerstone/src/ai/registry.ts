import type { ImageVolume } from '../utils/extractDisplaySetVolume';
import { CT_CONFIG, MRI_CONFIG } from './models/vertebrae';
import { runInWorker } from './runInWorker';
import type { AIProgressEvent } from './progress';

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
    opts: { onnxUrl: string; onProgress?: (event: AIProgressEvent) => void }
  ) => Promise<LocalModelResult>;
}

export const LOCAL_MODELS: Record<string, LocalModel> = {
  vertebrae_ct: {
    id: 'vertebrae_ct',
    name: 'Vertebrae (CT)',
    description:
      'nnU-Net v2 (TotalSegmentator). 26 labels incl. sacrum + S1, L5 → C1. Expects a CT series.',
    modality: 'CT',
    onnxFile: 'vertebrae_ct.onnx',
    labelNames: CT_CONFIG.labels,
    run: (volume, opts) =>
      runInWorker(volume, {
        modelId: 'vertebrae_ct',
        onnxUrl: opts.onnxUrl,
        onProgress: opts.onProgress,
      }),
  },
  vertebrae_mri: {
    id: 'vertebrae_mri',
    name: 'Vertebrae (MRI)',
    description:
      'nnU-Net v2 (TotalSegmentator MRI). 25 labels incl. sacrum, L5 → C1. Expects an MR series.',
    modality: 'MR',
    onnxFile: 'vertebrae_mri.onnx',
    labelNames: MRI_CONFIG.labels,
    run: (volume, opts) =>
      runInWorker(volume, {
        modelId: 'vertebrae_mri',
        onnxUrl: opts.onnxUrl,
        onProgress: opts.onProgress,
      }),
  },
};
