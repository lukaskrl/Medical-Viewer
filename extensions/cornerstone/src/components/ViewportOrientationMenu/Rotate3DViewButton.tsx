import React, { ReactNode, useEffect, useState } from 'react';
import { Enums } from '@cornerstonejs/core';
import { Icons, Button, useIconPresentation } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { isModelRotating } from '../../utils/viewport3DModelRotation';

const ROTATE_ICON = 'Tool3DRotate';
const LABEL = 'Tilt model';

/**
 * Top-left action-corner toggle shown in 3D (volume render) viewports next to
 * the "center view" button. Toggling it starts/stops a continuous left/right
 * tilt animation of the current model via the `toggle3DModelRotation` command.
 *
 * The animation itself lives outside React (see `viewport3DModelRotation`), so
 * it keeps running while this button is unmounted — the action corners unmount
 * whenever the mouse leaves the viewport. On (re)mount we read the current
 * animation state so the highlight stays in sync.
 */
export function Rotate3DViewButton(
  props: withAppTypes<{
    viewportId: string;
    location?: string;
    isOpen?: boolean;
    onOpen?: () => void;
    onClose?: () => void;
    disabled?: boolean;
  }>
): ReactNode {
  const { viewportId, disabled } = props;
  const { commandsManager, servicesManager } = useSystem();
  const { cornerstoneViewportService } = servicesManager.services;
  const { IconContainer, className: iconClassName, containerProps } = useIconPresentation();

  const [isRotating, setIsRotating] = useState(() => isModelRotating(viewportId));

  // Resync the highlight with the (out-of-React) animation state on remount or
  // when this button is reused for a different viewport.
  useEffect(() => {
    setIsRotating(isModelRotating(viewportId));
  }, [viewportId]);

  const is3D =
    cornerstoneViewportService.getCornerstoneViewport(viewportId)?.type ===
    Enums.ViewportType.VOLUME_3D;

  // Tilting only makes sense for a 3D volume render viewport.
  if (!is3D) {
    return null;
  }

  const handleClick = () => {
    if (disabled) {
      return;
    }
    const nowRotating = commandsManager.run('toggle3DModelRotation', { viewportId });
    setIsRotating(!!nowRotating);
  };

  const Icon = <Icons.ByName name={ROTATE_ICON} className={iconClassName} />;

  if (IconContainer) {
    return (
      <IconContainer
        id="rotate3DView"
        icon={ROTATE_ICON}
        label={LABEL}
        tooltip={LABEL}
        isActive={isRotating}
        disabled={disabled}
        onInteraction={handleClick}
        {...containerProps}
      >
        {Icon}
      </IconContainer>
    );
  }

  return (
    <Button
      variant={isRotating ? 'default' : 'ghost'}
      size="icon"
      disabled={disabled}
      aria-label={LABEL}
      onClick={handleClick}
    >
      {Icon}
    </Button>
  );
}

export default Rotate3DViewButton;
