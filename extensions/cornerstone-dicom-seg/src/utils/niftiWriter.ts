import pako from 'pako';
import type { SegmentationVolume } from './extractSegmentationVolume';

// NIfTI-1 datatype codes
const DT_UINT8 = 2;
const DT_INT16 = 4;
const DT_FLOAT32 = 16;
const DT_UINT16 = 512;

const HEADER_SIZE = 348;
const VOX_OFFSET = 352; // header + 4 bytes padding to align voxel data

/**
 * Volume payload accepted by buildNiftiBuffer. SegmentationVolume narrows
 * `data` to label types (Uint8/Uint16); this widens to also accept raw CT
 * payloads (Int16 / Float32) so the same writer can serialize image volumes
 * for AI inference uploads.
 */
export type NiftiWritableVolume = Omit<SegmentationVolume, 'data'> & {
  data: Uint8Array | Uint16Array | Int16Array | Float32Array;
};

function pickDatatype(data: NiftiWritableVolume['data']): { datatype: number; bitpix: number } {
  if (data instanceof Float32Array) {
    return { datatype: DT_FLOAT32, bitpix: 32 };
  }
  if (data instanceof Int16Array) {
    return { datatype: DT_INT16, bitpix: 16 };
  }
  if (data instanceof Uint16Array) {
    return { datatype: DT_UINT16, bitpix: 16 };
  }
  return { datatype: DT_UINT8, bitpix: 8 };
}

/**
 * Write a NIfTI-1 single-file (.nii) buffer for the given volume.
 *
 * The affine is built so voxel index (i, j, k) maps to the patient point at
 * voxel center in NIfTI's canonical RAS+ space (mm). DICOM stores geometry in
 * LPS, so we negate the X and Y rows when writing sform/qform.
 */
export function buildNiftiBuffer(volume: NiftiWritableVolume): ArrayBuffer {
  const { data, width, height, depth, spacing, origin, rowDirection, columnDirection, sliceDirection } =
    volume;

  const { datatype, bitpix } = pickDatatype(data);
  const bytesPerVoxel = bitpix / 8;

  const voxelBytes = data.byteLength;
  const totalSize = VOX_OFFSET + voxelBytes;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  const littleEndian = true;

  // ---- Header (348 bytes) ----
  view.setInt32(0, HEADER_SIZE, littleEndian); // sizeof_hdr
  // data_type[10] (offset 4) — leave zeros
  // db_name[18] (offset 14) — leave zeros
  view.setInt32(32, 0, littleEndian); // extents
  view.setInt16(36, 0, littleEndian); // session_error
  u8[38] = 0; // regular
  u8[39] = 0; // dim_info

  // dim[8] — short array starting at offset 40
  view.setInt16(40, 3, littleEndian); // dim[0] = number of dimensions
  view.setInt16(42, width, littleEndian); // dim[1]
  view.setInt16(44, height, littleEndian); // dim[2]
  view.setInt16(46, depth, littleEndian); // dim[3]
  view.setInt16(48, 1, littleEndian); // dim[4]
  view.setInt16(50, 1, littleEndian); // dim[5]
  view.setInt16(52, 1, littleEndian); // dim[6]
  view.setInt16(54, 1, littleEndian); // dim[7]

  view.setFloat32(56, 0, littleEndian); // intent_p1
  view.setFloat32(60, 0, littleEndian); // intent_p2
  view.setFloat32(64, 0, littleEndian); // intent_p3
  view.setInt16(68, 0, littleEndian); // intent_code

  view.setInt16(70, datatype, littleEndian); // datatype
  view.setInt16(72, bitpix, littleEndian); // bitpix
  view.setInt16(74, 0, littleEndian); // slice_start

  // pixdim[8] — float array starting at offset 76
  view.setFloat32(76, 1, littleEndian); // pixdim[0] (qfac, set later)
  view.setFloat32(80, spacing[0], littleEndian); // pixdim[1]
  view.setFloat32(84, spacing[1], littleEndian); // pixdim[2]
  view.setFloat32(88, spacing[2], littleEndian); // pixdim[3]
  view.setFloat32(92, 0, littleEndian); // pixdim[4]
  view.setFloat32(96, 0, littleEndian); // pixdim[5]
  view.setFloat32(100, 0, littleEndian); // pixdim[6]
  view.setFloat32(104, 0, littleEndian); // pixdim[7]

  view.setFloat32(108, VOX_OFFSET, littleEndian); // vox_offset
  view.setFloat32(112, 1, littleEndian); // scl_slope
  view.setFloat32(116, 0, littleEndian); // scl_inter
  view.setInt16(120, 0, littleEndian); // slice_end
  u8[122] = 0; // slice_code
  u8[123] = 2 | (8 << 3); // xyzt_units: mm (2) + sec (8 << 3)
  view.setFloat32(124, 0, littleEndian); // cal_max
  view.setFloat32(128, 0, littleEndian); // cal_min
  view.setFloat32(132, 0, littleEndian); // slice_duration
  view.setFloat32(136, 0, littleEndian); // toffset
  view.setInt32(140, 0, littleEndian); // glmax
  view.setInt32(144, 0, littleEndian); // glmin

  // descrip[80] (offset 148)
  writeString(u8, 148, 'OHIF segmentation export', 80);
  // aux_file[24] (offset 228) — leave zeros

  // sform/qform — affine from voxel indices (i,j,k) to mm in RAS+.
  // In LPS, voxel→world is:
  //   P = origin + i*spacing[0]*rowDir + j*spacing[1]*colDir + k*spacing[2]*sliceDir
  // RAS+ = (-X_LPS, -Y_LPS, Z_LPS), so negate the first two components.
  const m = [
    [
      -rowDirection[0] * spacing[0],
      -columnDirection[0] * spacing[1],
      -sliceDirection[0] * spacing[2],
      -origin[0],
    ],
    [
      -rowDirection[1] * spacing[0],
      -columnDirection[1] * spacing[1],
      -sliceDirection[1] * spacing[2],
      -origin[1],
    ],
    [
      rowDirection[2] * spacing[0],
      columnDirection[2] * spacing[1],
      sliceDirection[2] * spacing[2],
      origin[2],
    ],
  ];

  view.setInt16(252, 1, littleEndian); // qform_code: scanner anat
  view.setInt16(254, 1, littleEndian); // sform_code: scanner anat

  // Build the qform from the RAS rotation (M's leading 3x3 with spacing factored out).
  const rRas: [[number, number, number], [number, number, number], [number, number, number]] = [
    [-rowDirection[0], -columnDirection[0], -sliceDirection[0]],
    [-rowDirection[1], -columnDirection[1], -sliceDirection[1]],
    [rowDirection[2], columnDirection[2], sliceDirection[2]],
  ];

  // Determinant — if negative, NIfTI represents it with qfac = -1 on the k axis.
  const det =
    rRas[0][0] * (rRas[1][1] * rRas[2][2] - rRas[1][2] * rRas[2][1]) -
    rRas[0][1] * (rRas[1][0] * rRas[2][2] - rRas[1][2] * rRas[2][0]) +
    rRas[0][2] * (rRas[1][0] * rRas[2][1] - rRas[1][1] * rRas[2][0]);

  const qfac = det < 0 ? -1 : 1;
  view.setFloat32(76, qfac, littleEndian); // pixdim[0] = qfac

  // Build a proper-rotation matrix R for the quaternion by flipping k if qfac = -1.
  const R = [
    [rRas[0][0], rRas[0][1], rRas[0][2] * qfac],
    [rRas[1][0], rRas[1][1], rRas[1][2] * qfac],
    [rRas[2][0], rRas[2][1], rRas[2][2] * qfac],
  ];

  const { b, c, d } = rotationMatrixToQuaternion(R);
  view.setFloat32(256, b, littleEndian); // quatern_b
  view.setFloat32(260, c, littleEndian); // quatern_c
  view.setFloat32(264, d, littleEndian); // quatern_d
  view.setFloat32(268, m[0][3], littleEndian); // qoffset_x
  view.setFloat32(272, m[1][3], littleEndian); // qoffset_y
  view.setFloat32(276, m[2][3], littleEndian); // qoffset_z

  // srow_x[4]
  view.setFloat32(280, m[0][0], littleEndian);
  view.setFloat32(284, m[0][1], littleEndian);
  view.setFloat32(288, m[0][2], littleEndian);
  view.setFloat32(292, m[0][3], littleEndian);
  // srow_y[4]
  view.setFloat32(296, m[1][0], littleEndian);
  view.setFloat32(300, m[1][1], littleEndian);
  view.setFloat32(304, m[1][2], littleEndian);
  view.setFloat32(308, m[1][3], littleEndian);
  // srow_z[4]
  view.setFloat32(312, m[2][0], littleEndian);
  view.setFloat32(316, m[2][1], littleEndian);
  view.setFloat32(320, m[2][2], littleEndian);
  view.setFloat32(324, m[2][3], littleEndian);

  // intent_name[16] (offset 328) — leave zeros
  // magic (offset 344) — "n+1\0" identifies a single-file NIfTI
  u8[344] = 0x6e; // n
  u8[345] = 0x2b; // +
  u8[346] = 0x31; // 1
  u8[347] = 0x00;

  // bytes 348..351 are padding zeros before voxel data — already zero.

  // ---- Voxel data ----
  // Copy the raw bytes of the typed array regardless of element size — the
  // header above already declared the correct datatype/bitpix.
  const dataView = new Uint8Array(buffer, VOX_OFFSET, voxelBytes);
  dataView.set(new Uint8Array(data.buffer, data.byteOffset, voxelBytes));

  // bytesPerVoxel unused but kept for clarity of the byte-count math above.
  void bytesPerVoxel;

  return buffer;
}

/**
 * Gzip a NIfTI buffer to produce a .nii.gz payload.
 */
export function gzipNifti(buffer: ArrayBuffer): Uint8Array {
  return pako.gzip(new Uint8Array(buffer));
}

function writeString(u8: Uint8Array, offset: number, str: string, maxLen: number): void {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);
  const len = Math.min(encoded.length, maxLen - 1);
  for (let i = 0; i < len; i++) {
    u8[offset + i] = encoded[i];
  }
  u8[offset + len] = 0;
}

/**
 * Convert a proper rotation matrix (det = +1) to the NIfTI quaternion encoding,
 * which stores only the (b, c, d) imaginary components (a is implied via
 * a = sqrt(1 - b^2 - c^2 - d^2)).
 *
 * Reference: nifti1.h, nifti_mat44_to_quatern() in the NIfTI reference code.
 */
function rotationMatrixToQuaternion(R: number[][]): { b: number; c: number; d: number } {
  const r11 = R[0][0];
  const r12 = R[0][1];
  const r13 = R[0][2];
  const r21 = R[1][0];
  const r22 = R[1][1];
  const r23 = R[1][2];
  const r31 = R[2][0];
  const r32 = R[2][1];
  const r33 = R[2][2];

  const a2 = 1 + r11 + r22 + r33;
  let a: number;
  let b: number;
  let c: number;
  let d: number;

  if (a2 > 0.5) {
    a = 0.5 * Math.sqrt(a2);
    b = 0.25 * (r32 - r23) / a;
    c = 0.25 * (r13 - r31) / a;
    d = 0.25 * (r21 - r12) / a;
  } else {
    const xd = 1 + r11 - (r22 + r33);
    const yd = 1 + r22 - (r11 + r33);
    const zd = 1 + r33 - (r11 + r22);
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd);
      c = 0.25 * (r12 + r21) / b;
      d = 0.25 * (r13 + r31) / b;
      a = 0.25 * (r32 - r23) / b;
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd);
      b = 0.25 * (r12 + r21) / c;
      d = 0.25 * (r23 + r32) / c;
      a = 0.25 * (r13 - r31) / c;
    } else {
      d = 0.5 * Math.sqrt(zd);
      b = 0.25 * (r13 + r31) / d;
      c = 0.25 * (r23 + r32) / d;
      a = 0.25 * (r21 - r12) / d;
    }
    if (a < 0) {
      b = -b;
      c = -c;
      d = -d;
    }
  }

  return { b, c, d };
}
