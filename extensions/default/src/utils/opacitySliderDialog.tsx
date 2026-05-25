import React, { useState } from 'react';
import { FooterAction, Slider } from '@ohif/ui-next';

type OpacitySliderDialogProps = {
  value: number;
  hide: () => void;
  onChange?: (value: number) => void;
  onSave: (value: number) => void;
};

function OpacitySliderDialog({ value, hide, onChange, onSave }: OpacitySliderDialogProps) {
  const initial = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
  const [opacity, setOpacity] = useState(initial);

  const handleChange = ([next]: number[]) => {
    setOpacity(next);
    onChange?.(next);
  };

  return (
    <div className="w-[300px] p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-foreground text-sm">Opacity</span>
        <span className="text-muted-foreground text-sm tabular-nums">
          {Math.round(opacity * 100)}%
        </span>
      </div>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={[opacity]}
        onValueChange={handleChange}
      />
      <FooterAction>
        <FooterAction.Right>
          <FooterAction.Secondary
            onClick={() => {
              onChange?.(initial);
              hide();
            }}
          >
            Cancel
          </FooterAction.Secondary>
          <FooterAction.Primary
            onClick={() => {
              hide();
              onSave(opacity);
            }}
          >
            Save
          </FooterAction.Primary>
        </FooterAction.Right>
      </FooterAction>
    </div>
  );
}

export default OpacitySliderDialog;
