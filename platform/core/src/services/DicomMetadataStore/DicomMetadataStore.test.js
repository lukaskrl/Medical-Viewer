import DicomMetadataStore from './DicomMetadataStore';

const { EVENTS } = DicomMetadataStore;

const addSeries = (StudyInstanceUID, SeriesInstanceUID) =>
  DicomMetadataStore.addInstances([
    { StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID: `${SeriesInstanceUID}-1` },
  ]);

describe('DicomMetadataStore removal', () => {
  let events;
  let subscriptions;

  beforeEach(() => {
    events = [];
    subscriptions = [EVENTS.SERIES_REMOVED, EVENTS.STUDY_REMOVED].map(eventName =>
      DicomMetadataStore.subscribe(eventName, ({ StudyInstanceUID, SeriesInstanceUID }) =>
        events.push([eventName, StudyInstanceUID, SeriesInstanceUID])
      )
    );
  });

  afterEach(() => {
    subscriptions.forEach(({ unsubscribe }) => unsubscribe());
    DicomMetadataStore.getStudyInstanceUIDs().forEach(uid => DicomMetadataStore.removeStudy(uid));
  });

  it('removes a series and keeps the study while it has other series', () => {
    addSeries('study-1', 'series-1');
    addSeries('study-1', 'series-2');

    DicomMetadataStore.removeSeries('study-1', 'series-1');

    expect(DicomMetadataStore.getSeries('study-1', 'series-1')).toBeUndefined();
    expect(DicomMetadataStore.getSeries('study-1', 'series-2')).toBeDefined();
    expect(events).toEqual([[EVENTS.SERIES_REMOVED, 'study-1', 'series-1']]);
  });

  it('removes the study with its last series', () => {
    addSeries('study-1', 'series-1');

    DicomMetadataStore.removeSeries('study-1', 'series-1');

    expect(DicomMetadataStore.getStudy('study-1')).toBeUndefined();
    expect(events).toEqual([
      [EVENTS.SERIES_REMOVED, 'study-1', 'series-1'],
      [EVENTS.STUDY_REMOVED, 'study-1', undefined],
    ]);
  });

  it('removes a study with all of its series, once', () => {
    addSeries('study-1', 'series-1');
    addSeries('study-1', 'series-2');
    addSeries('study-2', 'series-3');

    DicomMetadataStore.removeStudy('study-1');

    expect(DicomMetadataStore.getStudyInstanceUIDs()).toEqual(['study-2']);
    expect(events).toEqual([
      [EVENTS.SERIES_REMOVED, 'study-1', 'series-1'],
      [EVENTS.SERIES_REMOVED, 'study-1', 'series-2'],
      [EVENTS.STUDY_REMOVED, 'study-1', undefined],
    ]);
  });

  it('ignores unknown studies and series', () => {
    addSeries('study-1', 'series-1');

    DicomMetadataStore.removeSeries('study-1', 'missing');
    DicomMetadataStore.removeStudy('missing');

    expect(DicomMetadataStore.getStudyInstanceUIDs()).toEqual(['study-1']);
    expect(events).toEqual([]);
  });
});
