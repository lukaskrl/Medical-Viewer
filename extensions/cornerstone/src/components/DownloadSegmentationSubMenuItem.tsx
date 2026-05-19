import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuSubContent,
  DropdownMenuItem,
  Icons,
} from '@ohif/ui-next';

import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';

interface DownloadSegmentationSubMenuItemProps {
  segmentationId: string;
  segmentationRepresentationType: string;
  allowExport: boolean;
  actions: {
    downloadSegmentationDicom: (segmentationId: string) => void;
    downloadSegmentationNifti: (segmentationId: string) => void;
    downloadSegmentationNrrd: (segmentationId: string) => void;
  };
}

export const DownloadSegmentationSubMenuItem: React.FC<DownloadSegmentationSubMenuItemProps> = ({
  segmentationId,
  segmentationRepresentationType,
  allowExport,
  actions,
}) => {
  const { t } = useTranslation('SegmentationPanel');
  const isLabelmap = segmentationRepresentationType === SegmentationRepresentations.Labelmap;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="pl-1">
        <Icons.Download className="text-foreground" />
        <span className="pl-2">{t('Download')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          {isLabelmap && (
            <DropdownMenuItem
              onClick={e => {
                e.preventDefault();
                actions.downloadSegmentationDicom(segmentationId);
              }}
              disabled={!allowExport}
            >
              {t('DICOM SEG (.dcm)')}
            </DropdownMenuItem>
          )}
          {isLabelmap && (
            <DropdownMenuItem
              onClick={e => {
                e.preventDefault();
                actions.downloadSegmentationNifti(segmentationId);
              }}
              disabled={!allowExport}
            >
              {t('NIfTI (.nii.gz)')}
            </DropdownMenuItem>
          )}
          {isLabelmap && (
            <DropdownMenuItem
              onClick={e => {
                e.preventDefault();
                actions.downloadSegmentationNrrd(segmentationId);
              }}
              disabled={!allowExport}
            >
              {t('NRRD (.nrrd)')}
            </DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
};
