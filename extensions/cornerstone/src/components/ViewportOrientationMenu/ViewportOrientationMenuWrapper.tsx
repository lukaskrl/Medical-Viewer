import React, { ReactNode } from 'react';
import { Enums } from '@cornerstonejs/core';
import { useSystem } from '@ohif/core';
import ViewportOrientationMenu from './ViewportOrientationMenu';
import { Center3DViewButton } from './Center3DViewButton';
import { useViewportDisplaySets } from '../../hooks/useViewportDisplaySets';

export function ViewportOrientationMenuWrapper(
  props: withAppTypes<{
    viewportId: string;
    location: string;
    isOpen?: boolean;
    onOpen?: () => void;
    onClose?: () => void;
    iconSize?: number;
    disabled?: boolean;
  }>
): ReactNode {
  const { viewportId } = props;
  const { servicesManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const { viewportDisplaySets } = useViewportDisplaySets(viewportId);

  if (!viewportDisplaySets.length) {
    return null;
  }

  // In a 3D (volume render) viewport, switching the acquisition orientation is
  // meaningless, so the orientation button becomes a "center view" button.
  const is3D =
    cornerstoneViewportService.getCornerstoneViewport(viewportId)?.type ===
    Enums.ViewportType.VOLUME_3D;

  if (is3D) {
    return <Center3DViewButton {...props} />;
  }

  return (
    <ViewportOrientationMenu
      {...props}
      displaySets={viewportDisplaySets}
    />
  );
}
