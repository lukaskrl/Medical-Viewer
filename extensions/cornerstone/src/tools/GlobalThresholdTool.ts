import { BaseTool } from '@cornerstonejs/tools';

/**
 * GlobalThreshold
 *
 * A placeholder labelmap tool that performs no viewport interaction. It exists only so the
 * "Global Threshold" toolbar button has an active-tool state, which is what drives its
 * inline options panel (the intensity range slider + Apply button). The actual thresholding
 * of the whole volume is done by the `runVolumeThreshold` command invoked from that panel.
 */
class GlobalThresholdTool extends BaseTool {
  static toolName = 'GlobalThreshold';

  constructor(
    toolProps = {},
    defaultToolProps = {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: {},
    }
  ) {
    super(toolProps, defaultToolProps);
  }
}

export default GlobalThresholdTool;
