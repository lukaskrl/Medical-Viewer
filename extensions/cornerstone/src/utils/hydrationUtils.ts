function getUpdatedViewportsForSegmentation({
  viewportId,
  servicesManager,
  displaySetInstanceUIDs,
}: withAppTypes) {
  const { hangingProtocolService, viewportGridService } = servicesManager.services;

  const { isHangingProtocolLayout } = viewportGridService.getState();

  const viewport = getTargetViewport({ viewportId, viewportGridService });
  const targetViewportId = viewport.viewportOptions.viewportId;

  const updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
    targetViewportId,
    displaySetInstanceUIDs[0],
    isHangingProtocolLayout
  );

  // eslint-disable-next-line no-console
  console.log(
    `[SEG-LOAD] ${performance.now().toFixed(0)} getUpdatedViewportsForSegmentation: target=${targetViewportId} -> ${updatedViewports?.length ?? 0} viewport(s) require update:`,
    (updatedViewports ?? []).map(v => v.viewportId)
  );

  return updatedViewports;
}

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

export { getUpdatedViewportsForSegmentation };
