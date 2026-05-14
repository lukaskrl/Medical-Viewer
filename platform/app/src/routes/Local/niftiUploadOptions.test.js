import {
  findMatchingStudyForNifti,
  inferNiftiImportKind,
  NIFTI_IMPORT_KINDS,
} from './niftiUploadOptions';

describe('niftiUploadOptions', () => {
  it('infers segmentation from a segmentation filename suffix', () => {
    expect(inferNiftiImportKind('case-001_seg.nii.gz')).toBe(NIFTI_IMPORT_KINDS.SEGMENTATION);
  });

  it('defaults to volume for regular nifti filenames', () => {
    expect(inferNiftiImportKind('case-001.nii')).toBe(NIFTI_IMPORT_KINDS.VOLUME);
  });

  it('finds a matching study from a similar series description', () => {
    const studies = [
      {
        StudyInstanceUID: 'study-1',
        description: 'Baseline CT',
        series: [
          {
            SeriesInstanceUID: 'series-1',
            SeriesDescription: 'baseline_ct',
            instances: [],
          },
        ],
      },
      {
        StudyInstanceUID: 'study-2',
        description: 'Follow up',
        series: [
          {
            SeriesInstanceUID: 'series-2',
            SeriesDescription: 'followup',
            instances: [],
          },
        ],
      },
    ];

    expect(findMatchingStudyForNifti('followup_seg.nii.gz', studies)).toEqual(studies[1]);
  });
});