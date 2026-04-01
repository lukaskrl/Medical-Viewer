#!/usr/bin/env python3

from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path
import sys
import uuid


def _require_dependencies() -> None:
	try:
		import numpy  # noqa: F401
		import pydicom  # noqa: F401
		import SimpleITK  # noqa: F401
		import highdicom  # noqa: F401
	except ImportError as exc:
		raise SystemExit(
			"Missing dependency: "
			f"{exc}.\n"
			"Install required packages with:\n"
			"  pip install numpy pydicom SimpleITK highdicom"
		)


def _uid() -> str:
	import pydicom.uid

	return pydicom.uid.generate_uid()


def _datetime_now() -> tuple[str, str]:
	now = dt.datetime.now()
	return now.strftime("%Y%m%d"), now.strftime("%H%M%S")


def _load_and_align_segmentation(image_path: Path, seg_path: Path):
	import SimpleITK as sitk

	image = sitk.ReadImage(str(image_path))
	seg = sitk.ReadImage(str(seg_path))

	same_geometry = (
		image.GetSize() == seg.GetSize()
		and image.GetSpacing() == seg.GetSpacing()
		and image.GetOrigin() == seg.GetOrigin()
		and image.GetDirection() == seg.GetDirection()
	)

	if not same_geometry:
		resampler = sitk.ResampleImageFilter()
		resampler.SetReferenceImage(image)
		resampler.SetInterpolator(sitk.sitkNearestNeighbor)
		resampler.SetDefaultPixelValue(0)
		seg = resampler.Execute(seg)

	return image, seg


def _build_base_dicom_dataset(
	*,
	patient_name: str,
	patient_id: str,
	study_uid: str,
	series_uid: str,
	frame_of_reference_uid: str,
	study_description: str,
	series_description: str,
):
	import pydicom

	ds = pydicom.dataset.Dataset()
	date, time = _datetime_now()

	ds.SpecificCharacterSet = "ISO_IR 100"
	ds.PatientName = patient_name
	ds.PatientID = patient_id
	ds.PatientSex = "O"
	ds.PatientBirthDate = ""
	ds.StudyInstanceUID = study_uid
	ds.SeriesInstanceUID = series_uid
	ds.StudyDate = date
	ds.StudyTime = time
	ds.AccessionNumber = ""
	ds.ReferringPhysicianName = ""
	ds.StudyID = "1"
	ds.SeriesNumber = 1
	ds.Modality = "CT"
	ds.Manufacturer = "Medical-Viewer"
	ds.InstitutionName = ""
	ds.StudyDescription = study_description
	ds.SeriesDescription = series_description
	ds.FrameOfReferenceUID = frame_of_reference_uid
	ds.PositionReferenceIndicator = ""

	return ds


def write_dicom_image_series(
	image_path: Path,
	output_dir: Path,
	patient_name: str,
	patient_id: str,
) -> list:
	import numpy as np
	import pydicom
	from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
	from pydicom.uid import ExplicitVRLittleEndian
	import SimpleITK as sitk

	output_dir.mkdir(parents=True, exist_ok=True)

	image_sitk = sitk.ReadImage(str(image_path))
	image_np = sitk.GetArrayFromImage(image_sitk)  # z, y, x

	spacing = image_sitk.GetSpacing()  # x, y, z
	direction = image_sitk.GetDirection()  # 3x3 row-major

	row_cosines = [float(direction[0]), float(direction[3]), float(direction[6])]
	col_cosines = [float(direction[1]), float(direction[4]), float(direction[7])]

	study_uid = _uid()
	series_uid = _uid()
	frame_of_reference_uid = _uid()

	base = _build_base_dicom_dataset(
		patient_name=patient_name,
		patient_id=patient_id,
		study_uid=study_uid,
		series_uid=series_uid,
		frame_of_reference_uid=frame_of_reference_uid,
		study_description="NIfTI Conversion",
		series_description="Converted Image",
	)

	source_instances = []

	for z in range(image_np.shape[0]):
		frame_index = (0, 0, int(z))
		ipp = image_sitk.TransformIndexToPhysicalPoint(frame_index)

		plane = image_np[z, :, :].astype(np.int16)

		file_meta = FileMetaDataset()
		file_meta.FileMetaInformationVersion = b"\x00\x01"
		file_meta.MediaStorageSOPClassUID = pydicom.uid.CTImageStorage
		file_meta.MediaStorageSOPInstanceUID = _uid()
		file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
		file_meta.ImplementationClassUID = pydicom.uid.PYDICOM_IMPLEMENTATION_UID

		ds = FileDataset(None, {}, file_meta=file_meta, preamble=b"\x00" * 128)
		ds.update(base)

		date, time = _datetime_now()
		ds.InstanceCreationDate = date
		ds.InstanceCreationTime = time

		ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
		ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID

		ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
		ds.InstanceNumber = z + 1

		ds.Rows = int(plane.shape[0])
		ds.Columns = int(plane.shape[1])
		ds.PixelSpacing = [float(spacing[1]), float(spacing[0])]
		ds.SliceThickness = float(spacing[2])
		ds.SpacingBetweenSlices = float(spacing[2])
		ds.ImagePositionPatient = [float(v) for v in ipp]
		ds.ImageOrientationPatient = row_cosines + col_cosines

		ds.SamplesPerPixel = 1
		ds.PhotometricInterpretation = "MONOCHROME2"
		ds.BitsAllocated = 16
		ds.BitsStored = 16
		ds.HighBit = 15
		ds.PixelRepresentation = 1

		ds.RescaleIntercept = 0
		ds.RescaleSlope = 1
		ds.WindowCenter = int(np.percentile(plane, 50))
		ds.WindowWidth = max(1, int(np.percentile(plane, 95) - np.percentile(plane, 5)))

		ds.PixelData = plane.tobytes()

		ds.is_little_endian = True
		ds.is_implicit_VR = False

		out_file = output_dir / f"IM_{z + 1:04d}.dcm"
		ds.save_as(str(out_file), write_like_original=False)

		source_instances.append(ds)

	return source_instances


def write_dicom_seg(
	image_path: Path,
	seg_path: Path,
	source_instances: list,
	output_path: Path,
	patient_name: str,
	patient_id: str,
	segment_label: str,
) -> None:
	import numpy as np
	import highdicom as hd
	from pydicom.sr.codedict import codes
	import SimpleITK as sitk

	image_sitk, seg_sitk = _load_and_align_segmentation(image_path=image_path, seg_path=seg_path)

	_ = image_sitk
	seg_np = sitk.GetArrayFromImage(seg_sitk)
	binary_mask = (seg_np > 0).astype(np.uint8)

	if np.max(binary_mask) == 0:
		raise SystemExit("Segmentation appears empty after alignment (all zeros).")

	segment = hd.seg.SegmentDescription(
		segment_number=1,
		segment_label=segment_label,
		segmented_property_category=codes.SCT.Tissue,
		segmented_property_type=codes.SCT.Tissue,
		algorithm_type=hd.seg.SegmentAlgorithmTypeValues.MANUAL,
	)

	date, time = _datetime_now()

	seg_dataset = hd.seg.Segmentation(
		source_images=source_instances,
		pixel_array=binary_mask,
		segmentation_type=hd.seg.SegmentationTypeValues.BINARY,
		segment_descriptions=[segment],
		series_instance_uid=_uid(),
		sop_instance_uid=_uid(),
		series_number=300,
		instance_number=1,
		manufacturer="Medical-Viewer",
		manufacturer_model_name="NIfTI2DICOMSEG",
		software_versions="1.0",
		device_serial_number=str(uuid.uuid4())[:12],
		content_description="Converted segmentation",
		content_creator_name="NIFTI^CONVERTER",
		content_label="SEGMENTATION",
	)
	seg_dataset.PatientName = patient_name
	seg_dataset.PatientID = patient_id
	seg_dataset.SeriesDate = date
	seg_dataset.SeriesTime = time

	output_path.parent.mkdir(parents=True, exist_ok=True)
	seg_dataset.save_as(str(output_path), write_like_original=False)


def parse_args() -> argparse.Namespace:
	default_image = Path("testdata/GL003.nii.gz")
	default_seg = Path("testdata/GL003_seg.nii.gz")
	default_out = Path("testdata/GL003_dicom")

	parser = argparse.ArgumentParser(
		description=(
			"Convert a NIfTI image and NIfTI segmentation into a DICOM image series "
			"and DICOM SEG that remain spatially aligned."
		)
	)
	parser.add_argument("--image", type=Path, default=default_image, help="Path to source image NIfTI")
	parser.add_argument("--seg", type=Path, default=default_seg, help="Path to source segmentation NIfTI")
	parser.add_argument(
		"--output-dir",
		type=Path,
		default=default_out,
		help="Output directory for DICOM slices and SEG",
	)
	parser.add_argument("--patient-name", default="GL003^Demo", help="DICOM PatientName")
	parser.add_argument("--patient-id", default="GL003", help="DICOM PatientID")
	parser.add_argument("--segment-label", default="Lesion", help="SEG segment label")
	return parser.parse_args()


def main() -> None:
	args = parse_args()
	_require_dependencies()

	if not args.image.exists():
		raise SystemExit(f"Image NIfTI not found: {args.image}")
	if not args.seg.exists():
		raise SystemExit(f"Segmentation NIfTI not found: {args.seg}")

	image_out_dir = args.output_dir / "images"
	seg_out_path = args.output_dir / "seg.dcm"

	source_instances = write_dicom_image_series(
		image_path=args.image,
		output_dir=image_out_dir,
		patient_name=args.patient_name,
		patient_id=args.patient_id,
	)

	write_dicom_seg(
		image_path=args.image,
		seg_path=args.seg,
		source_instances=source_instances,
		output_path=seg_out_path,
		patient_name=args.patient_name,
		patient_id=args.patient_id,
		segment_label=args.segment_label,
	)

	print(f"DICOM image series written to: {image_out_dir}")
	print(f"DICOM SEG written to: {seg_out_path}")


if __name__ == "__main__":
	try:
		main()
	except KeyboardInterrupt:
		sys.exit(130)
