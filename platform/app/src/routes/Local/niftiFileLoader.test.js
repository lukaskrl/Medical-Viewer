jest.mock('@ohif/core', () => ({
  DicomMetadataStore: {
    addInstances: jest.fn(),
    getStudy: jest.fn(),
    getSeries: jest.fn(),
    getStudyInstanceUIDs: jest.fn(),
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
const {
  buildReferencedSeriesSequence,
  registerParsedVolume,
  addRegisteredVolumeToMetadataStore,
} = require('./niftiFileLoader');

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
              Modality: 'CT',
              SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
              SOPInstanceUID: 'instance-1',
            },
            {
              Modality: 'CT',
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

describe('niftiFileLoader grid-matched references', () => {
  let studies;

  // Minimal in-memory stand-in for the DicomMetadataStore.
  beforeEach(() => {
    studies = new Map();
    DicomMetadataStore.addInstances.mockImplementation(instances => {
      instances.forEach(instance => {
        if (!studies.has(instance.StudyInstanceUID)) {
          studies.set(instance.StudyInstanceUID, { series: [] });
        }
        const study = studies.get(instance.StudyInstanceUID);
        let series = study.series.find(s => s.SeriesInstanceUID === instance.SeriesInstanceUID);
        if (!series) {
          series = { SeriesInstanceUID: instance.SeriesInstanceUID, instances: [] };
          study.series.push(series);
        }
        series.instances.push(instance);
      });
    });
    DicomMetadataStore.getStudy.mockImplementation(uid => studies.get(uid));
    DicomMetadataStore.getSeries.mockImplementation((studyUID, seriesUID) =>
      studies.get(studyUID)?.series.find(s => s.SeriesInstanceUID === seriesUID)
    );
    DicomMetadataStore.getStudyInstanceUIDs.mockImplementation(() => [...studies.keys()]);
  });

  const parseVolume = overrides =>
    registerParsedVolume({
      scalarData: new Uint8Array(3 * 4 * 5),
      rows: 4,
      columns: 3,
      numSlices: 5,
      spacing: [0.5, 0.5, 2],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      origin: [10, 20, 30],
      ArrayConstructor: Uint8Array,
      ...overrides,
    });

  const importFile = (name, fileKind, overrides, options = {}) => {
    const studyUID = addRegisteredVolumeToMetadataStore(parseVolume(overrides), name, {
      fileKind,
      ...options,
    });
    return studyUID.then(StudyInstanceUID => {
      const study = studies.get(StudyInstanceUID);
      return study.series[study.series.length - 1].instances[0];
    });
  };

  const canvases = () =>
    [...studies.values()].flatMap(study =>
      study.series.filter(series => series.instances[0].isBlankSegmentationCanvas)
    );

  it('puts standalone segmentations on the same grid onto one shared blank canvas', async () => {
    const first = await importFile('liver_seg', 'segmentation');
    const second = await importFile('spleen_seg', 'segmentation');

    expect(canvases()).toHaveLength(1);
    expect(first.referencedSeriesInstanceUID).toBe(canvases()[0].SeriesInstanceUID);
    expect(second.referencedSeriesInstanceUID).toBe(first.referencedSeriesInstanceUID);
    expect(second.StudyInstanceUID).toBe(first.StudyInstanceUID);
    expect(second.PatientName).toBe(first.PatientName);
  });

  it('gives a segmentation on another grid its own canvas in the same study and space', async () => {
    const first = await importFile('liver_seg', 'segmentation');
    const second = await importFile('crop_seg', 'segmentation', { numSlices: 3 });

    expect(canvases()).toHaveLength(2);
    expect(second.referencedSeriesInstanceUID).not.toBe(first.referencedSeriesInstanceUID);
    expect(second.StudyInstanceUID).toBe(first.StudyInstanceUID);
    expect(second.FrameOfReferenceUID).toBe(first.FrameOfReferenceUID);
  });

  it('references a loaded volume with the same grid instead of creating a canvas', async () => {
    const volume = await importFile('case-001', 'volume');
    const seg = await importFile('case-001_seg', 'segmentation');

    expect(canvases()).toHaveLength(0);
    expect(seg.referencedSeriesInstanceUID).toBe(volume.SeriesInstanceUID);
    expect(seg.StudyInstanceUID).toBe(volume.StudyInstanceUID);
  });

  it('prefers a real volume over an existing canvas on the same grid', async () => {
    await importFile('liver_seg', 'segmentation');
    const volume = await importFile('case-001', 'volume');
    const seg = await importFile('spleen_seg', 'segmentation');

    expect(seg.referencedSeriesInstanceUID).toBe(volume.SeriesInstanceUID);
  });

  it('matches a volume whose slices are stored in the opposite order', async () => {
    const volume = await importFile('case-001', 'volume', {
      origin: [10, 20, 38],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, -1],
    });
    const seg = await importFile('case-001_seg', 'segmentation', {
      origin: [10, 20, 30],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    });

    expect(seg.referencedSeriesInstanceUID).toBe(volume.SeriesInstanceUID);
  });

  it('keeps an explicit link and takes the linked series frame of reference', async () => {
    DicomMetadataStore.addInstances([
      {
        StudyInstanceUID: 'dicom-study',
        SeriesInstanceUID: 'dicom-series',
        SOPInstanceUID: 'dicom-1',
        SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
        Modality: 'CT',
        FrameOfReferenceUID: 'dicom-for',
        PatientID: 'patient-1',
        PatientName: 'Doe^Jane',
      },
    ]);

    const seg = await importFile('other_seg', 'segmentation', { numSlices: 7 }, {
      referenceStudyInstanceUID: 'dicom-study',
      referenceSeriesInstanceUID: 'dicom-series',
    });

    expect(seg.referencedSeriesInstanceUID).toBe('dicom-series');
    expect(seg.StudyInstanceUID).toBe('dicom-study');
    expect(seg.FrameOfReferenceUID).toBe('dicom-for');
    expect(seg.PatientID).toBe('patient-1');
    expect(seg.PatientName).toBe('Doe^Jane');
    expect(canvases()).toHaveLength(0);
  });
});
