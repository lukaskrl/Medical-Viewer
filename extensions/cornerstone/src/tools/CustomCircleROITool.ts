import { CircleROITool } from '@cornerstonejs/tools';

/**
 * Custom CircleROI tool that extends the base CircleROI tool.
 * The actual interaction logic (center click to move, edge click to resize)
 * is handled at the viewport level in OHIFCornerstoneViewport.tsx
 */
class CustomCircleROITool extends CircleROITool {
  static toolName = 'CircleROI';
}

export default CustomCircleROITool;
