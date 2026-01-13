import { measurementTrackingMode } from '../contexts/TrackedMeasurementsContext/promptBeginTracking';

type CheckHasDirtyAndSimplifiedModeProps = {
  servicesManager: AppTypes.ServicesManager;
  appConfig: AppTypes.Config;
  displaySetInstanceUID: string;
};

const onDoubleClickHandler = {
  callbacks: [
    ({ activeViewportId, servicesManager, isHangingProtocolLayout, appConfig, commandsManager }) =>
      async displaySetInstanceUID => {
        const {
          hangingProtocolService,
          viewportGridService,
          uiNotificationService,
          displaySetService,
          panelService,
        } = servicesManager.services;
        let updatedViewports = [];
        const viewportId = activeViewportId;
        const haveDirtyMeasurementsInSimplifiedMode = checkHasDirtyAndSimplifiedMode({
          servicesManager,
          appConfig,
          displaySetInstanceUID,
        });

        // Check if this is an SR displaySet - if so, directly hydrate it
        // to skip the preview and prompt, loading the referenced image directly
        const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
        if (displaySet?.Modality === 'SR') {
          try {
            // Load the SR displaySet if not already loaded
            if (!displaySet.isLoaded && displaySet.load) {
              await displaySet.load();
            }

            // Directly hydrate the SR and show the referenced image
            await commandsManager.runCommand('hydrateSecondaryDisplaySet', {
              displaySet,
              viewportId,
            });

            // Automatically open the measurements panel after SR hydration
            panelService.activatePanel(
              '@ohif/extension-measurement-tracking.panelModule.trackedMeasurements',
              true
            );
            return;
          } catch (error) {
            console.warn('Failed to hydrate SR displaySet:', error);
            uiNotificationService.show({
              title: 'SR Load',
              message: 'Failed to load the structured report measurements.',
              type: 'error',
              duration: 3000,
            });
            return;
          }
        }

        try {
          if (!haveDirtyMeasurementsInSimplifiedMode) {
            updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
              viewportId,
              displaySetInstanceUID,
              isHangingProtocolLayout
            );
            viewportGridService.setDisplaySetsForViewports(updatedViewports);
          }
        } catch (error) {
          console.warn(error);
          // Fallback: if HP required selectors fail (e.g., isReconstructable),
          // keep the layout and place the display set in the active viewport.
          try {
            viewportGridService.setDisplaySetsForViewport({
              viewportId,
              displaySetInstanceUIDs: [displaySetInstanceUID],
            });
          } catch (e2) {
            console.warn(e2);
            uiNotificationService.show({
              title: 'Thumbnail Double Click',
              message: 'The selected display sets could not be added to the viewport.',
              type: 'error',
              duration: 3000,
            });
          }
        }
      },
  ],
};

const customOnDropHandlerCallback = async props => {
  const handled = checkHasDirtyAndSimplifiedMode(props);
  return Promise.resolve({ handled });
};

const checkHasDirtyAndSimplifiedMode = (props: CheckHasDirtyAndSimplifiedModeProps) => {
  const { servicesManager, appConfig, displaySetInstanceUID } = props;
  const simplifiedMode = appConfig.measurementTrackingMode === measurementTrackingMode.SIMPLIFIED;
  const { measurementService, displaySetService } = servicesManager.services;
  const measurements = measurementService.getMeasurements();
  const haveDirtyMeasurements =
    measurements.some(m => m.isDirty) ||
    (measurements.length && measurementService.getIsMeasurementDeletedIndividually());
  const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
  const hasDirtyAndSimplifiedMode =
    displaySet.Modality === 'SR' && simplifiedMode && haveDirtyMeasurements;
  return hasDirtyAndSimplifiedMode;
};

export { onDoubleClickHandler, customOnDropHandlerCallback };
