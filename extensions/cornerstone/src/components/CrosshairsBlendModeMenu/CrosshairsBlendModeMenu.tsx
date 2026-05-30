import React from 'react';
import { useSystem } from '@ohif/core';
import { useToolbar } from '@ohif/core/src/hooks/useToolbar';
import {
  Icons,
  ToolButton,
  ToolButtonList,
  ToolButtonListDefault,
  ToolButtonListDivider,
  ToolButtonListDropDown,
  ToolButtonListItem,
} from '@ohif/ui-next';

type BlendModeKey = 'mip' | 'avg' | 'minip';

const OPTIONS: { id: BlendModeKey; label: string }[] = [
  { id: 'mip', label: 'MIP' },
  { id: 'avg', label: 'Average' },
  { id: 'minip', label: 'MinIP' },
];

interface Props {
  buttonSection: string;
  id: string;
}

function CrosshairsBlendModeMenu({ buttonSection, id }: Props) {
  const { commandsManager } = useSystem();
  const { onInteraction, toolbarButtons } = useToolbar({ buttonSection } as any);

  const [currentBlendMode, setCurrentBlendMode] = React.useState<BlendModeKey>('mip');

  if (!toolbarButtons?.length) {
    return null;
  }

  const primary = toolbarButtons[0].componentProps;

  const handleBlendModeChange = (blendMode: BlendModeKey) => {
    setCurrentBlendMode(blendMode);
    commandsManager.runCommand('setCrosshairsSlabBlendMode', { blendMode });
  };

  return (
    <ToolButtonList>
      <ToolButtonListDefault
        tooltip={primary.tooltip || primary.label}
        disabledText={primary.disabledText}
        disabled={primary.disabled}
      >
        <div
          data-cy={`${id}-split-button-primary`}
          data-tool={primary.id}
          data-active={primary.isActive}
        >
          <ToolButton
            {...primary}
            onInteraction={({ itemId }) =>
              onInteraction?.({ id, itemId, commands: primary.commands })
            }
            className={primary.className}
          />
        </div>
      </ToolButtonListDefault>
      <ToolButtonListDivider className={primary.isActive ? 'opacity-0' : 'opacity-100'} />
      <div data-cy={`${id}-split-button-secondary`}>
        <ToolButtonListDropDown>
          {OPTIONS.map(option => (
            <ToolButtonListItem
              key={option.id}
              onSelect={() => handleBlendModeChange(option.id)}
              data-cy={`crosshairs-blend-mode-${option.id}`}
            >
              <div className="mr-1 flex w-6 items-center justify-start">
                {currentBlendMode === option.id ? (
                  <Icons.Checked className="text-primary h-6 w-6" />
                ) : null}
              </div>
              <span className="flex-1 text-left">{option.label}</span>
            </ToolButtonListItem>
          ))}
        </ToolButtonListDropDown>
      </div>
    </ToolButtonList>
  );
}

export default CrosshairsBlendModeMenu;
