import {
  getEnabledElement,
  cache,
  utilities as csCoreUtils,
  BaseVolumeViewport,
} from '@cornerstonejs/core';
import {
  BaseTool,
  utilities as cstUtils,
  segmentation as csSeg,
  Types,
} from '@cornerstonejs/tools';

const { floodFill } = cstUtils.segmentation;
const { triggerSegmentationDataModified } = csSeg.triggerSegmentationEvents;

/**
 * RemoveIslandTool
 *
 * A click-activated labelmap tool. When the user clicks inside a segment region
 * in a slice viewport, the entire 3D connected component (face-connected
 * "island") sharing that voxel's segment value is removed (set to background).
 *
 * It targets whichever segment is under the cursor, not only the active one.
 */
class RemoveIslandTool extends BaseTool {
  static toolName = 'RemoveIsland';

  constructor(
    toolProps = {},
    defaultToolProps = {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: {},
    }
  ) {
    super(toolProps, defaultToolProps);
  }

  preMouseDownCallback = (evt: Types.EventTypes.MouseDownActivateEventType): boolean => {
    const { element, currentPoints } = evt.detail;
    const worldPoint = currentPoints.world;

    const enabledElement = getEnabledElement(element);
    if (!enabledElement) {
      return false;
    }

    const { viewport } = enabledElement;
    const activeSegmentation = csSeg.activeSegmentation.getActiveSegmentation(viewport.id);
    if (!activeSegmentation) {
      return false;
    }

    const { segmentationId } = activeSegmentation;
    const resolved = this._getLabelmapVoxelData(activeSegmentation, viewport);
    if (!resolved) {
      console.warn(
        'RemoveIslandTool: could not resolve labelmap voxel data for the active viewport.'
      );
      return false;
    }

    const { imageData, voxelManager } = resolved;
    const dimensions = imageData.getDimensions();
    const seed = csCoreUtils
      .transformWorldToIndex(imageData, worldPoint)
      .map(Math.round) as [number, number, number];

    const [si, sj, sk] = seed;
    if (
      si < 0 ||
      sj < 0 ||
      sk < 0 ||
      si >= dimensions[0] ||
      sj >= dimensions[1] ||
      sk >= dimensions[2]
    ) {
      return false;
    }

    // The segment value actually under the click (any segment, not just active).
    const targetValue = voxelManager.getAtIJK(si, sj, sk);
    if (!targetValue) {
      // Clicked on background - nothing to remove.
      return true;
    }

    const inBounds = (x: number, y: number, z: number) =>
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < dimensions[0] &&
      y < dimensions[1] &&
      z < dimensions[2];

    const getter = (x: number, y: number, z: number) =>
      inBounds(x, y, z) ? voxelManager.getAtIJK(x, y, z) : undefined;

    // 3D face-connected flood fill from the clicked voxel.
    const { flooded } = floodFill(getter, seed, { diagonals: false });

    if (!flooded.length) {
      return true;
    }

    // setAtIJK records the touched k-slices on the voxel manager, which we hand
    // to the data-modified event so only those slices are re-rendered.
    flooded.forEach(([x, y, z]) => {
      voxelManager.setAtIJK(x, y, z, 0);
    });

    triggerSegmentationDataModified(
      segmentationId,
      voxelManager.getArrayOfModifiedSlices(),
      targetValue
    );

    return true;
  };

  /**
   * Resolves the labelmap imageData + voxelManager for the current viewport.
   * Volume viewports (axial/sagittal/coronal MPR) are fully supported; stack
   * labelmaps are not handled here.
   */
  private _getLabelmapVoxelData(
    segmentation,
    viewport
  ): { imageData; voxelManager } | null {
    const labelmapData = segmentation.representationData.Labelmap as {
      volumeId?: string;
    };

    if (viewport instanceof BaseVolumeViewport && labelmapData?.volumeId) {
      const segmentationVolume = cache.getVolume(labelmapData.volumeId);
      if (!segmentationVolume) {
        return null;
      }

      return {
        imageData: segmentationVolume.imageData,
        voxelManager: segmentationVolume.voxelManager,
      };
    }

    return null;
  }
}

export default RemoveIslandTool;
