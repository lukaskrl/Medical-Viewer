import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

// jsdom/node test env lacks these web globals; they exist in the browser runtime.
global.TextEncoder = global.TextEncoder || NodeTextEncoder;
global.TextDecoder = global.TextDecoder || NodeTextDecoder;

import pako from 'pako';
import { parseNrrd } from './nrrdParser';

/** Assemble an in-memory NRRD ArrayBuffer from header lines + a data Uint8Array. */
function buildNrrd(headerLines, dataBytes) {
  const headerText = headerLines.join('\n') + '\n\n';
  const headerBytes = new TextEncoder().encode(headerText);
  const out = new Uint8Array(headerBytes.length + dataBytes.length);
  out.set(headerBytes, 0);
  out.set(dataBytes, headerBytes.length);
  return out.buffer;
}

const BASE_HEADER = [
  'NRRD0004',
  'type: uint8',
  'dimension: 3',
  'space: left-posterior-superior',
  'sizes: 2 2 2',
  'space directions: (1,0,0) (0,2,0) (0,0,3)',
  'kinds: domain domain domain',
  'endian: little',
  'encoding: raw',
  'space origin: (10,20,30)',
];

describe('parseNrrd', () => {
  it('parses a basic 3D raw uint8 volume with its geometry', () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const result = parseNrrd(buildNrrd(BASE_HEADER, data));

    expect(result.columns).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.numSlices).toBe(2);
    expect(result.spacing).toEqual([1, 2, 3]);
    expect(result.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(result.origin).toEqual([10, 20, 30]);
    expect(result.ArrayConstructor).toBe(Uint8Array);
    expect(Array.from(result.scalarData)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('converts a RAS space to DICOM LPS', () => {
    const header = BASE_HEADER.map(line =>
      line.startsWith('space:') ? 'space: right-anterior-superior' : line
    );
    const result = parseNrrd(buildNrrd(header, new Uint8Array(8)));

    // X and Y world components flip; Z is unchanged.
    expect(result.direction).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
    expect(result.origin).toEqual([-10, -20, 30]);
  });

  it('falls back to "spacings" when no space directions are present', () => {
    const header = [
      'NRRD0004',
      'type: uint8',
      'dimension: 3',
      'sizes: 2 2 2',
      'spacings: 0.5 0.5 2',
      'encoding: raw',
    ];
    const result = parseNrrd(buildNrrd(header, new Uint8Array(8)));

    expect(result.spacing).toEqual([0.5, 0.5, 2]);
    expect(result.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(result.origin).toEqual([0, 0, 0]);
  });

  it('decodes gzip-encoded data', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const header = BASE_HEADER.map(line =>
      line.startsWith('encoding:') ? 'encoding: gzip' : line
    );
    const compressed = pako.gzip(data);
    const result = parseNrrd(buildNrrd(header, compressed));

    expect(Array.from(result.scalarData)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('collapses a 4D layered volume to its first layer', () => {
    const header = [
      'NRRD0004',
      'type: uint8',
      'dimension: 4',
      'space: left-posterior-superior',
      'sizes: 2 2 2 2',
      'space directions: none (1,0,0) (0,1,0) (0,0,1)',
      'kinds: list domain domain domain',
      'endian: little',
      'encoding: raw',
    ];
    // Layer axis is fastest-varying, so layer 0 is every other byte.
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const result = parseNrrd(buildNrrd(header, data));

    expect(result.columns).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.numSlices).toBe(2);
    expect(Array.from(result.scalarData)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it('throws on an unsupported encoding', () => {
    const header = BASE_HEADER.map(line =>
      line.startsWith('encoding:') ? 'encoding: bzip2' : line
    );
    expect(() => parseNrrd(buildNrrd(header, new Uint8Array(8)))).toThrow(/unsupported encoding/i);
  });
});
