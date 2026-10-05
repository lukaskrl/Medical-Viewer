import React from 'react';
import { FooterAction } from '@ohif/ui-next';

export function RemoveFromViewerModal({ hide, onConfirm, message, details }) {
  return (
    <div className="text-foreground text-[13px]">
      <p>{message}</p>
      {details && <p className="mt-2">{details}</p>}
      <p className="text-muted-foreground mt-2">
        The source data is not deleted, so it can be loaded again.
      </p>
      <FooterAction className="mt-4">
        <FooterAction.Right>
          <FooterAction.Secondary onClick={hide}>Cancel</FooterAction.Secondary>
          <FooterAction.Primary
            onClick={() => {
              hide();
              onConfirm();
            }}
          >
            Remove
          </FooterAction.Primary>
        </FooterAction.Right>
      </FooterAction>
    </div>
  );
}
