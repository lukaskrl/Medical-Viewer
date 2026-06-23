import pako from 'pako';

/**
 * Minimal NRRD ("Nearly Raw Raster Data") reader for the browser.
 *
 * Parses an attached NRRD file (header + binary data in one file, the `.nrrd`
 * variant — detached `.nhdr` is not supported) into the same geometry shape the
 * NIfTI loader produces, so the rest of the local-import pipeline (image loader,
 * metadata-store injection, SEG handler) can treat the two formats identically.
 *
 * Supported: `raw` and `gzip` encodings, little/big endian, the common scalar
 * types, `space directions` / `space origin` / `space` (RAS↔LPS) or a plain
 * `spacings` fallback, and 3D volumes plus 4D label data (the extra layer/list
 * axis is collapsed to its first index, e.g. 3D Slicer overlapping segments).
 *
 * Reference: https://teem.sourceforge.net/nrrd/format.html
 */

// NRRD `type:` field → TypedArray constructor. Mirrors getArrayConstructor in
// niftiFileLoader so both formats map to identical cornerstone pixel types.
const NRRD_TYPE_TO_ARRAY = {
  'signed char': Int8Array,
  int8: Int8Array,
  int8_t: Int8Array,
  uchar: Uint8Array,
  'unsigned char': Uint8Array,
  uint8: Uint8Array,
  uint8_t: Uint8Array,
  short: Int16Array,
  'short int': Int16Array,
  'signed short': Int16Array,
  'signed short int': Int16Array,
  int16: Int16Array,
  int16_t: Int16Array,
  ushort: Uint16Array,
  'unsigned short': Uint16Array,
  'unsigned short int': Uint16Array,
  uint16: Uint16Array,
  uint16_t: Uint16Array,
  int: Int32Array,
  'signed int': Int32Array,
  int32: Int32Array,
  int32_t: Int32Array,
  uint: Uint32Array,
  'unsigned int': Uint32Array,
  uint32: Uint32Array,
  uint32_t: Uint32Array,
  float: Float32Array,
  float32: Float32Array,
  double: Float64Array,
  float64: Float64Array,
};

// Axis "kinds" that carry no spatial geometry (e.g. the leading axis of a 4D
// overlapping-segment labelmap, or per-voxel vector/colour components).
const NON_SPATIAL_KINDS = new Set([
  'list',
  'vector',
  'point',
  'covariant-vector',
  'normal',
  'complex',
  'rgb-color',
  'rgba-color',
  'hsv-color',
  'xyz-color',
  '2-vector',
  '3-vector',
  '4-vector',
  '3-color',
  '4-color',
  'scalar',
]);

function isNrrdFileName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.nrrd') || lower.endsWith('.nhdr');
}

/** Locate the blank line that separates the ASCII header from the binary data. */
function findHeaderEnd(bytes) {
  for (let i = 0; i + 1 < bytes.length; i++) {
    // "\n\n"
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return { headerLength: i, dataStart: i + 2 };
    }
    // "\r\n\r\n"
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      i + 3 < bytes.length &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return { headerLength: i, dataStart: i + 4 };
    }
  }
  throw new Error(
    'NRRD: could not find the blank line separating header from data (detached .nhdr files are not supported).'
  );
}

/** Split a vector list like "(1,0,0) (0,1,0) none" into [[1,0,0],[0,1,0],null]. */
function parseVectorList(value) {
  const tokens = value.match(/none|\([^)]*\)/gi) || [];
  return tokens.map(token => {
    if (token.toLowerCase() === 'none') {
      return null;
    }
    return token
      .slice(1, -1)
      .split(',')
      .map(component => parseFloat(component.trim()));
  });
}

function parseVector(value) {
  const match = value.match(/\(([^)]*)\)/);
  if (!match) {
    return null;
  }
  return match[1].split(',').map(component => parseFloat(component.trim()));
}

function parseHeader(headerText) {
  const lines = headerText.split(/\r?\n/);
  const magic = lines[0] || '';
  if (!magic.startsWith('NRRD')) {
    throw new Error('NRRD: missing magic line (file does not start with "NRRD").');
  }

  const fields = {};
  const keyValuePairs = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim() || line.startsWith('#')) {
      continue;
    }

    // key/value pairs use ":=" (e.g. Slicer segment metadata); fields use ": ".
    const kvMatch = line.match(/^([^:]+):=(.*)$/);
    if (kvMatch) {
      keyValuePairs[kvMatch[1].trim()] = kvMatch[2].trim();
      continue;
    }

    const fieldMatch = line.match(/^([^:]+):\s*(.*)$/);
    if (fieldMatch) {
      fields[fieldMatch[1].trim().toLowerCase()] = fieldMatch[2].trim();
    }
  }

  return { fields, keyValuePairs };
}

/** World-axis sign flips to bring the file's `space` into DICOM LPS. */
function getLpsSign(space) {
  const normalized = (space || '').toLowerCase().replace(/[\s_]/g, '-');

  // RAS (NIfTI-style): negate X and Y to reach LPS, matching the NIfTI loader.
  if (normalized.startsWith('right-anterior-superior') || normalized === 'ras') {
    return [-1, -1, 1];
  }
  // LAS: only the anterior↔posterior (Y) axis differs from LPS.
  if (normalized.startsWith('left-anterior-superior') || normalized === 'las') {
    return [1, -1, 1];
  }
  // LPS / scanner-xyz / 3D-right-handed / unspecified → already DICOM-aligned.
  return [1, 1, 1];
}

/** Normalize -0 to 0 so sign-flipped geometry components stay clean. */
function noNegZero(value) {
  return value === 0 ? 0 : value;
}

function getArrayConstructor(type) {
  const constructor = NRRD_TYPE_TO_ARRAY[type.toLowerCase().trim()];
  if (!constructor) {
    throw new Error(`NRRD: unsupported voxel type "${type}".`);
  }
  return constructor;
}

/** Reverse byte order in place for big-endian multi-byte data (JS is little-endian). */
function byteSwap(bytes, bytesPerElement) {
  if (bytesPerElement <= 1) {
    return bytes;
  }
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i + bytesPerElement <= bytes.length; i += bytesPerElement) {
    for (let j = 0; j < bytesPerElement; j++) {
      swapped[i + j] = bytes[i + bytesPerElement - 1 - j];
    }
  }
  return swapped;
}

/** Decide which axes are spatial (carry geometry) vs. layer/component axes. */
function resolveSpatialAxes(sizes, directionEntries, kinds) {
  if (directionEntries) {
    const spatial = [];
    directionEntries.forEach((entry, index) => {
      if (entry !== null) {
        spatial.push(index);
      }
    });
    if (spatial.length) {
      return spatial;
    }
  }

  if (kinds?.length) {
    const spatial = [];
    kinds.forEach((kind, index) => {
      if (!NON_SPATIAL_KINDS.has(kind.toLowerCase())) {
        spatial.push(index);
      }
    });
    if (spatial.length) {
      return spatial;
    }
  }

  // Fall back to the first (up to) three axes.
  return sizes.map((_, index) => index).slice(0, Math.min(3, sizes.length));
}

/**
 * Extract a contiguous, X-fastest 3D scalar volume from the full NRRD data,
 * fixing every non-spatial axis to index 0. For a plain 3D volume this is the
 * identity; for 4D layer data it de-interleaves the first layer.
 */
function extractSpatialVolume(fullData, sizes, spatialAxes) {
  const [ax, ay, az] = spatialAxes;
  const columns = sizes[ax];
  const rows = sizes[ay];
  const numSlices = sizes[az];

  // Stride of each axis (axis 0 varies fastest in NRRD memory layout).
  const strides = new Array(sizes.length);
  strides[0] = 1;
  for (let i = 1; i < sizes.length; i++) {
    strides[i] = strides[i - 1] * sizes[i - 1];
  }

  const isIdentity =
    spatialAxes.length === sizes.length &&
    spatialAxes.every((axis, index) => axis === index);

  if (isIdentity) {
    return { scalarData: fullData, columns, rows, numSlices };
  }

  const scalarData = new fullData.constructor(columns * rows * numSlices);
  let out = 0;
  for (let z = 0; z < numSlices; z++) {
    for (let y = 0; y < rows; y++) {
      const base = y * strides[ay] + z * strides[az];
      for (let x = 0; x < columns; x++) {
        scalarData[out++] = fullData[base + x * strides[ax]];
      }
    }
  }
  return { scalarData, columns, rows, numSlices };
}

/**
 * Parse a NRRD ArrayBuffer into a normalized volume description.
 *
 * @param {ArrayBuffer} arrayBuffer raw file contents
 * @returns {{
 *   scalarData: TypedArray, columns: number, rows: number, numSlices: number,
 *   spacing: number[], direction: number[], origin: number[],
 *   ArrayConstructor: Function, keyValuePairs: Object, header: Object
 * }}
 */
export function parseNrrd(arrayBuffer) {
  const fileBytes = new Uint8Array(arrayBuffer);
  const { headerLength, dataStart } = findHeaderEnd(fileBytes);

  const headerText = new TextDecoder('utf-8').decode(fileBytes.subarray(0, headerLength));
  const { fields, keyValuePairs } = parseHeader(headerText);

  if (fields['data file'] || fields.datafile) {
    throw new Error('NRRD: detached data files are not supported (load the single-file .nrrd).');
  }

  const type = fields.type;
  if (!type) {
    throw new Error('NRRD: missing required "type" field.');
  }
  const ArrayConstructor = getArrayConstructor(type);
  const bytesPerElement = ArrayConstructor.BYTES_PER_ELEMENT;

  const sizes = (fields.sizes || '').trim().split(/\s+/).map(Number);
  if (!sizes.length || sizes.some(size => !Number.isFinite(size) || size <= 0)) {
    throw new Error('NRRD: missing or invalid "sizes" field.');
  }

  const encoding = (fields.encoding || 'raw').toLowerCase();
  const endian = (fields.endian || 'little').toLowerCase();

  // Geometry: prefer "space directions"; fall back to axis-aligned "spacings".
  const directionEntries = fields['space directions']
    ? parseVectorList(fields['space directions'])
    : null;
  const kinds = fields.kinds ? fields.kinds.trim().split(/\s+/) : null;
  const spatialAxes = resolveSpatialAxes(sizes, directionEntries, kinds);

  if (spatialAxes.length < 3) {
    throw new Error(
      `NRRD: expected a 3D volume but found ${spatialAxes.length} spatial axis/axes.`
    );
  }
  // Use the first three spatial axes (collapse any extra to index 0 on extract).
  const usedSpatialAxes = spatialAxes.slice(0, 3);

  // --- Decode the binary payload -------------------------------------------
  let dataBytes = fileBytes.subarray(dataStart);

  const byteSkip = parseInt(fields['byte skip'] ?? fields.byteskip ?? '0', 10) || 0;
  if (byteSkip > 0) {
    dataBytes = dataBytes.subarray(byteSkip);
  }

  if (encoding === 'gzip' || encoding === 'gz') {
    dataBytes = pako.ungzip(dataBytes);
  } else if (encoding === 'raw') {
    // already raw
  } else {
    throw new Error(`NRRD: unsupported encoding "${encoding}" (only raw and gzip are supported).`);
  }

  dataBytes = byteSwap(dataBytes, endian === 'big' ? bytesPerElement : 1);

  const totalElements = sizes.reduce((product, size) => product * size, 1);
  const expectedBytes = totalElements * bytesPerElement;
  if (dataBytes.length < expectedBytes) {
    throw new Error(
      `NRRD: data is smaller than expected (${dataBytes.length} < ${expectedBytes} bytes).`
    );
  }

  // Copy into a fresh, correctly-aligned buffer before viewing as the typed type.
  const fullData = new ArrayConstructor(totalElements);
  new Uint8Array(fullData.buffer).set(dataBytes.subarray(0, expectedBytes));

  const collapsedAxes = spatialAxes.length > 3 || sizes.length > 3;
  if (collapsedAxes) {
    console.warn(
      'NRRD: file has more than 3 axes; using the first layer/component of each extra axis.'
    );
  }

  const { scalarData, columns, rows, numSlices } = extractSpatialVolume(
    fullData,
    sizes,
    usedSpatialAxes
  );

  // --- World geometry (converted to DICOM LPS) -----------------------------
  const sign = getLpsSign(fields.space);

  let spacing;
  let direction;

  if (directionEntries) {
    const vectors = usedSpatialAxes.map(axis => directionEntries[axis] || [0, 0, 0]);
    spacing = vectors.map(vector =>
      Math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2)
    );
    direction = [];
    vectors.forEach((vector, index) => {
      const magnitude = spacing[index] || 1;
      direction.push(
        noNegZero((sign[0] * vector[0]) / magnitude),
        noNegZero((sign[1] * vector[1]) / magnitude),
        noNegZero((sign[2] * vector[2]) / magnitude)
      );
    });
    spacing = spacing.map(value => value || 1);
  } else {
    // No directions: axis-aligned volume using "spacings" (or unit spacing).
    const spacings = fields.spacings
      ? fields.spacings.trim().split(/\s+/).map(Number)
      : [];
    spacing = usedSpatialAxes.map(axis => {
      const value = spacings[axis];
      return Number.isFinite(value) && value > 0 ? value : 1;
    });
    direction = [
      sign[0], 0, 0,
      0, sign[1], 0,
      0, 0, sign[2],
    ];
  }

  const spaceOrigin = fields['space origin'] ? parseVector(fields['space origin']) : null;
  const origin = spaceOrigin
    ? [
        noNegZero(sign[0] * spaceOrigin[0]),
        noNegZero(sign[1] * spaceOrigin[1]),
        noNegZero(sign[2] * spaceOrigin[2]),
      ]
    : [0, 0, 0];

  return {
    scalarData,
    columns,
    rows,
    numSlices,
    spacing,
    direction,
    origin,
    ArrayConstructor,
    keyValuePairs,
    header: fields,
  };
}

export { isNrrdFileName };
export default { parseNrrd, isNrrdFileName };
