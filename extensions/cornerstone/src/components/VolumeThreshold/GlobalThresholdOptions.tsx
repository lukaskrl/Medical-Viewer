import React, { useEffect, useRef, useState } from 'react';
import { Button, Icons } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';
import { useTranslation } from 'react-i18next';
import { VolumeThresholdRange } from './VolumeThresholdRange';

type Range = [number, number];

// Throttle interval for re-thresholding the whole volume while dragging the slider. Low
// enough to feel live, high enough to avoid flooding the renderer with full-volume updates.
const PREVIEW_THROTTLE_MS = 100;

// How long the "Saved" confirmation stays on the Apply button after a successful commit.
const SAVED_FEEDBACK_MS = 1300;

/**
 * Options panel for the Global Threshold tool. As the user drags the intensity range
 * (bounded by the active volume's min/max), the result is previewed live on the whole
 * volume; pressing Apply commits that preview into the active segment. Leaving the tool
 * discards an uncommitted preview.
 */
export function GlobalThresholdOptions() {
  const { commandsManager, servicesManager } = useSystem();
  const { uiNotificationService } = servicesManager.services;
  const { t } = useTranslation('Buttons');
  const [range, setRange] = useState<Range | undefined>();
  const [hasPreview, setHasPreview] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const lastPreviewRef = useRef(0);
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Discard any uncommitted preview when the tool/panel is dismissed.
  useEffect(() => {
    return () => {
      if (trailingRef.current) {
        clearTimeout(trailingRef.current);
      }
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
      commandsManager.runCommand('clearVolumeThresholdPreview');
    };
  }, [commandsManager]);

  const handleChange = (next: Range, isUserChange: boolean) => {
    setRange(next);

    // Don't preview the initial full-range seed, only real user edits.
    if (!isUserChange) {
      return;
    }

    setHasPreview(true);

    // Throttle so the preview updates live *while* dragging (leading edge) without flooding,
    // and a trailing call guarantees the final position is previewed on release.
    const preview = () => {
      lastPreviewRef.current = Date.now();
      commandsManager.runCommand('previewVolumeThreshold', { range: next });
    };

    if (trailingRef.current) {
      clearTimeout(trailingRef.current);
      trailingRef.current = null;
    }

    const elapsed = Date.now() - lastPreviewRef.current;
    if (elapsed >= PREVIEW_THROTTLE_MS) {
      preview();
    } else {
      trailingRef.current = setTimeout(preview, PREVIEW_THROTTLE_MS - elapsed);
    }
  };

  const handleApply = () => {
    // Nothing to commit if the user hasn't previewed a range since the last save.
    if (!hasPreview) {
      return;
    }

    commandsManager.runCommand('acceptVolumeThreshold');
    setHasPreview(false);

    uiNotificationService?.show({
      title: t('Global Threshold'),
      message: t('Saved to segment'),
      type: 'success',
      duration: 1500,
    });

    setJustSaved(true);
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = setTimeout(() => setJustSaved(false), SAVED_FEEDBACK_MS);
  };

  return (
    <div className="flex flex-col space-y-2 px-1 py-2">
      <VolumeThresholdRange
        mode="global"
        value={range}
        onChange={handleChange}
      />
      <span className="text-muted-foreground text-xs">{t('Press Apply to save to the segment')}</span>
      <Button
        variant="default"
        disabled={!hasPreview && !justSaved}
        onClick={handleApply}
        className={`mr-auto transition-transform ${justSaved ? 'scale-105 animate-pulse' : ''}`}
      >
        {justSaved ? (
          <span className="flex items-center gap-1">
            <Icons.Checked className="h-4 w-4" />
            {t('Saved')}
          </span>
        ) : (
          t('Apply')
        )}
      </Button>
    </div>
  );
}

export default GlobalThresholdOptions;
