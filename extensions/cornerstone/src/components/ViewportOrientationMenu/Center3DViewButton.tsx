import React, { ReactNode } from 'react';
import { Icons, Button, useIconPresentation } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';

const CENTER_ICON = 'ToolCrosshair';
const LABEL = 'Center view';

/**
 * Top-left action-corner button shown in 3D (volume render) viewports in place
 * of the orientation menu. Clicking it recenters the camera on whatever is
 * currently visible via the `center3DViewport` command.
 */
export function Center3DViewButton(
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
  const { commandsManager } = useSystem();
  const { IconContainer, className: iconClassName, containerProps } = useIconPresentation();

  const handleClick = () => {
    if (disabled) {
      return;
    }
    commandsManager.run('center3DViewport', { viewportId });
  };

  const Icon = <Icons.ByName name={CENTER_ICON} className={iconClassName} />;

  if (IconContainer) {
    return (
      <IconContainer
        id="center3DView"
        icon={CENTER_ICON}
        label={LABEL}
        tooltip={LABEL}
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
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-label={LABEL}
      onClick={handleClick}
    >
      {Icon}
    </Button>
  );
}

export default Center3DViewButton;
