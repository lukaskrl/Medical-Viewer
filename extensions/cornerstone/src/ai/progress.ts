/**
 * Structured progress event emitted by AI inference pipelines.
 *
 * Carries a `phase` discriminator so the UI can map each update onto a
 * dedicated sub-range of the progress bar (e.g. inference patches occupy
 * the bulk of the bar; preprocessing a smaller prefix). The pipeline reports
 * what stage it is in; the UI decides how that stage maps to bar percentage.
 */
export type AIProgressEvent =
  | { phase: 'preprocess'; step: number; total: number; label: string }
  | { phase: 'inference'; patch: number; total: number }
  | { phase: 'postprocess'; step: number; total: number; label: string };
