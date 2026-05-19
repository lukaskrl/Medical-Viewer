import pako from 'pako';
import type { SegmentationVolume } from './extractSegmentationVolume';

/**
 * Build a NRRD file (header + raw binary data) for the given segmentation volume.
 *
 * Geometry is written in the DICOM "left-posterior-superior" world space so
 * downstream tools (3D Slicer, ITK-SNAP) interpret the directions identically
 * to the source DICOM. Data is stored uncompressed (`encoding: raw`).
 */
export function buildNrrdBuffer(volume: SegmentationVolume, options: { gzip?: boolean } = {}): ArrayBuffer {
  const {
    data,
    width,
    height,
    depth,
    spacing,
    origin,
    rowDirection,
    columnDirection,
    sliceDirection,
  } = volume;

  const isUint16 = data instanceof Uint16Array;
  const type = isUint16 ? 'uint16' : 'uint8';

  const directions = [
    scale(rowDirection, spacing[0]),
    scale(columnDirection, spacing[1]),
    scale(sliceDirection, spacing[2]),
  ];

  const encoding = options.gzip ? 'gzip' : 'raw';

  const headerLines = [
    'NRRD0004',
    `# OHIF segmentation export`,
    `type: ${type}`,
    'dimension: 3',
    'space: left-posterior-superior',
    `sizes: ${width} ${height} ${depth}`,
    `space directions: ${formatVec(directions[0])} ${formatVec(directions[1])} ${formatVec(directions[2])}`,
    'kinds: domain domain domain',
    'endian: little',
    `encoding: ${encoding}`,
    `space origin: ${formatVec(origin)}`,
  ];

  const headerText = headerLines.join('\n') + '\n\n';
  const headerBytes = new TextEncoder().encode(headerText);

  const rawData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const payload = options.gzip ? pako.gzip(rawData) : rawData;

  const out = new Uint8Array(headerBytes.length + payload.length);
  out.set(headerBytes, 0);
  out.set(payload, headerBytes.length);

  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function scale(
  v: [number, number, number],
  s: number
): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function formatVec(v: [number, number, number]): string {
  return `(${v[0]},${v[1]},${v[2]})`;
}
