/**
 * Lazy ONNX Runtime Web session factory.
 *
 * Forces WASM execution. WebGPU is intentionally NOT used: ORT Web's WebGPU
 * (JSEP) backend only implements 2-D convolutions, so this 3-D nnU-Net fails at
 * the first ConvTranspose ("currently only support 2-dimensional conv"). WASM
 * runs the full graph correctly; parallelism comes from running the whole
 * inference in a Worker.
 *
 * Sessions are cached by URL so repeated model invocations don't re-download /
 * re-compile.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferenceSession = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any;

const sessionCache = new Map<string, Promise<InferenceSession>>();
let ortPromise: Promise<OrtModule> | null = null;

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    // Dynamic import so onnxruntime-web is split into its own chunk and only
    // loaded when the user actually runs a local inference.
    ortPromise = import('onnxruntime-web').then(mod => {
      const ort = mod as unknown as OrtModule;
      // Point ORT at the /ort/ folder where the build copies the .wasm files.
      // Required in worker contexts because import.meta-based resolution lands
      // next to the worker chunk, not next to the .wasm files.
      if (ort?.env?.wasm) {
        ort.env.wasm.wasmPaths = '/ort/';
        // Single-threaded WASM avoids the cross-origin-isolation requirement;
        // we get parallelism by running the whole inference in a Worker.
        ort.env.wasm.numThreads = 1;
      }
      return ort;
    });
  }
  return ortPromise;
}

/**
 * Verify the URL points to a real ONNX file before handing it to ORT.
 *
 * Without this check, a missing file silently falls through to the SPA's
 * index.html fallback and ORT reports "protobuf parsing failed", which gives
 * no hint that the user just needs to run the export script.
 */
async function preflightOnnx(onnxUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(onnxUrl, { method: 'GET' });
  } catch (err) {
    throw new Error(
      `Could not fetch ${onnxUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    throw new Error(
      `ONNX model not found at ${onnxUrl} (HTTP ${response.status}). ` +
        `Generate it with: python ai/export_onnx.py`
    );
  }

  // Read the first few bytes — a real ONNX file starts with protobuf bytes
  // (typically 0x08 0x?? for the ir_version field), never with "<" / "<!".
  const buf = await response.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));
  const looksLikeHtml = head[0] === 0x3c; // '<'
  if (looksLikeHtml || buf.byteLength < 1024) {
    throw new Error(
      `${onnxUrl} did not return a valid ONNX file (got ${buf.byteLength} bytes, ` +
        `looks like ${looksLikeHtml ? 'HTML (probably the SPA fallback)' : 'an empty/truncated file'}). ` +
        `Generate the model with: python ai/export_onnx.py`
    );
  }

  // Stash the buffer on a private cache so ORT can use it without a second fetch.
  preflightedBuffers.set(onnxUrl, buf);
}

const preflightedBuffers = new Map<string, ArrayBuffer>();

export async function getInferenceSession(onnxUrl: string): Promise<InferenceSession> {
  const cached = sessionCache.get(onnxUrl);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    await preflightOnnx(onnxUrl);
    const ort = await loadOrt();
    const buffer = preflightedBuffers.get(onnxUrl) ?? onnxUrl;
    preflightedBuffers.delete(onnxUrl);
    return ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  })();

  sessionCache.set(onnxUrl, promise);
  try {
    return await promise;
  } catch (err) {
    sessionCache.delete(onnxUrl);
    throw err;
  }
}

export async function makeTensor(
  data: Float32Array,
  dims: number[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const ort = await loadOrt();
  return new ort.Tensor('float32', data, dims);
}
