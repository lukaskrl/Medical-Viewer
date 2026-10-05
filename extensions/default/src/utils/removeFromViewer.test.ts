import { collectDisplaySetsToRemove, findSegmentationsToRemove } from './removeFromViewer';

jest.mock('@ohif/core', () => ({ DicomMetadataStore: {} }));

const displaySet = (displaySetInstanceUID, props = {}) =>
  ({ displaySetInstanceUID, StudyInstanceUID: 'study-1', ...props }) as AppTypes.DisplaySet;

describe('collectDisplaySetsToRemove', () => {
  const ct = displaySet('ct', { SeriesInstanceUID: 'ct-series' });
  const ctSplit = displaySet('ct-split', { SeriesInstanceUID: 'ct-series' });
  const mr = displaySet('mr', { SeriesInstanceUID: 'mr-series' });
  const segByDisplaySet = displaySet('seg-1', {
    SeriesInstanceUID: 'seg-1-series',
    Modality: 'SEG',
    referencedDisplaySetInstanceUID: 'ct',
  });
  const segBySeries = displaySet('seg-2', {
    StudyInstanceUID: 'workspace',
    SeriesInstanceUID: 'seg-2-series',
    Modality: 'SEG',
    referencedSeriesInstanceUID: 'ct-series',
  });
  const all = [ct, ctSplit, mr, segByDisplaySet, segBySeries];

  const uids = displaySets => displaySets.map(ds => ds.displaySetInstanceUID).sort();

  it('removes the rest of the series and the segmentations that reference it', () => {
    expect(uids(collectDisplaySetsToRemove([ct], all))).toEqual(
      ['ct', 'ct-split', 'seg-1', 'seg-2'].sort()
    );
  });

  it('removes only the segmentation when a segmentation is picked', () => {
    expect(uids(collectDisplaySetsToRemove([segByDisplaySet], all))).toEqual(['seg-1']);
  });

  it('leaves unrelated series alone', () => {
    expect(uids(collectDisplaySetsToRemove([mr], all))).toEqual(['mr']);
  });
});

describe('findSegmentationsToRemove', () => {
  const segmentations = [
    { segmentationId: 'seg-1' },
    {
      segmentationId: 'drawn-on-ct',
      representationData: { Labelmap: { referencedImageIds: ['ct:1', 'ct:2'] } },
    },
    {
      segmentationId: 'drawn-on-mr',
      representationData: { Labelmap: { referencedImageIds: ['mr:1'] } },
    },
  ];

  it('finds hydrated segmentations of removed display sets and ones drawn on removed images', () => {
    expect(
      findSegmentationsToRemove(segmentations, new Set(['seg-1', 'ct']), new Set(['ct:1', 'ct:2']))
    ).toEqual(['seg-1', 'drawn-on-ct']);
  });
});
