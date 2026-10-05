import React, { useCallback, useEffect, useState } from 'react';
import { Numeric, useViewportGrid } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useViewportRendering } from '../../hooks';

type Range = [number, number];

interface VolumeThresholdRangeProps {
  /**
   * 'brush' pushes the selected range onto the threshold brush variants through the
   * `setThresholdRange` command. 'global' lifts the range to the parent, which previews it
   * against the whole volume.
   */
  mode: 'brush' | 'global';
  value?: Range;
  /**
   * Called with the new range. `isUserChange` is false when the value is just (re)seeded to
   * the volume's full extent (e.g. on load), and true when the user drags/types — this lets
   * the global panel avoid previewing the full-range default.
   */
  onChange?: (range: Range, isUserChange: boolean) => void;
}

/**
 * A double-range slider whose bounds are the active volume's intensity range
 * (`voxelManager.getRange()`, surfaced by `useViewportRendering` as `pixelValueRange`).
 * The number inputs let the user type exact thresholds, so the wide value range of e.g.
 * CT data is not a problem.
 */
export function VolumeThresholdRange({ mode, value, onChange }: VolumeThresholdRangeProps) {
  const { commandsManager } = useSystem();
  const [{ activeViewportId }] = useViewportGrid();
  const { pixelValueRange } = useViewportRendering(activeViewportId);
  const { min, max } = pixelValueRange;

  const [internalRange, setInternalRange] = useState<Range>([min, max]);
  const range = value ?? internalRange;

  const applyRange = useCallback(
    (next: Range, isUserChange: boolean) => {
      setInternalRange(next);
      if (mode === 'brush') {
        commandsManager.runCommand('setThresholdRange', { value: next });
      } else {
        onChange?.(next, isUserChange);
      }
    },
    [commandsManager, mode, onChange]
  );

  // Re-seed to the full volume extent whenever the active volume (and thus its range) changes.
  // This is not a user edit, so the global panel won't preview the full-range default.
  useEffect(() => {
    applyRange([min, max], false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max]);

  return (
    <Numeric.Container
      mode="doubleRange"
      values={range}
      onChange={val => Array.isArray(val) && applyRange(val as Range, true)}
      min={min}
      max={max}
      step={1}
    >
      <Numeric.DoubleRange showNumberInputs />
    </Numeric.Container>
  );
}

export default VolumeThresholdRange;
