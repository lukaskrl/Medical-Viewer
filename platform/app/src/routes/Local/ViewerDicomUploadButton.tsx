import React from 'react';
import { Icons, useModal, Tooltip, TooltipContent, TooltipTrigger } from '@ohif/ui-next';
import { useSystem } from '@ohif/core';

import ViewerDicomUpload from './ViewerDicomUpload';

/**
 * Icon button rendered next to the side panel close icon. Opens the upload
 * dialog so the user can add DICOM / NIfTI files to the current viewer
 * session without leaving the page.
 */
function ViewerDicomUploadButton() {
  const { show, hide } = useModal();
  const { extensionManager } = useSystem();

  const dataSource = extensionManager.getActiveDataSourceOrNull?.();

  if (!dataSource) {
    return null;
  }

  const openUpload = () => {
    show({
      title: 'Add studies to viewer',
      containerClassName: 'max-w-2xl',
      content: () => (
        <ViewerDicomUpload
          dataSource={dataSource}
          variant="modal"
          onUploaded={() => {
            // PanelStudyBrowser listens for STUDY_ADDED events and updates
            // itself, so we can close the dialog as soon as ingestion finishes.
            hide();
          }}
          onClose={hide}
        />
      ),
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={openUpload}
          className="text-primary hover:bg-primary/10 mr-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded"
          aria-label="Add studies to viewer"
        >
          <Icons.Upload className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Add studies to viewer</TooltipContent>
    </Tooltip>
  );
}

export default ViewerDicomUploadButton;
