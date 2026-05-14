jest.mock('@ohif/core', () => ({
  DicomMetadataStore: {
    getStudy: jest.fn(),
  },
}), { virtual: true });

jest.mock('@cornerstonejs/core', () => ({
  imageLoader: {
    registerImageLoader: jest.fn(),
  },
  utilities: {
    genericMetadataProvider: {
      add: jest.fn(),
    },
    VoxelManager: {
      createImageVoxelManager: jest.fn(),
    },
  },
}), { virtual: true });

jest.mock('@cornerstonejs/nifti-volume-loader', () => ({
  cornerstoneNiftiImageLoader: jest.fn(),
  helpers: {},
  init: jest.fn(),
}), { virtual: true });

jest.mock('nifti-reader-js', () => ({
  decompress: jest.fn(),
  isCompressed: jest.fn(),
  isNIFTI: jest.fn(),
  readHeader: jest.fn(),
  readImage: jest.fn(),
}), { virtual: true });

const { DicomMetadataStore } = require('@ohif/core');
const { buildReferencedSeriesSequence } = require('./niftiFileLoader');

describe('niftiFileLoader segmentation references', () => {
  beforeEach(() => {
    DicomMetadataStore.getStudy.mockReset();
  });

  it('returns the referenced series sequence as an object with instance references', () => {
    DicomMetadataStore.getStudy.mockReturnValue({
      series: [
        {
          SeriesInstanceUID: 'series-1',
          instances: [
            {
              SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
              SOPInstanceUID: 'instance-1',
            },
            {
              SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
              SOPInstanceUID: 'instance-2',
            },
          ],
        },
      ],
    });

    expect(
      buildReferencedSeriesSequence({
        referenceStudyInstanceUID: 'study-1',
        referenceSeriesInstanceUID: 'series-1',
      })
    ).toEqual({
      SeriesInstanceUID: 'series-1',
      ReferencedInstanceSequence: [
        {
          ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
          ReferencedSOPInstanceUID: 'instance-1',
        },
        {
          ReferencedSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
          ReferencedSOPInstanceUID: 'instance-2',
        },
      ],
    });
  });

  it('returns null when the referenced study does not have a matching series', () => {
    DicomMetadataStore.getStudy.mockReturnValue({
      series: [],
    });

    expect(
      buildReferencedSeriesSequence({
        referenceStudyInstanceUID: 'study-1',
        referenceSeriesInstanceUID: 'series-1',
      })
    ).toBeNull();
  });
});
