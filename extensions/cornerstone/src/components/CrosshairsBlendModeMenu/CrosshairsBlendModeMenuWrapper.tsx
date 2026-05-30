import React, { ReactNode } from 'react';
import CrosshairsBlendModeMenu from './CrosshairsBlendModeMenu';

interface Props {
  buttonSection: string;
  id: string;
}

export function CrosshairsBlendModeMenuWrapper(props: Props): ReactNode {
  return <CrosshairsBlendModeMenu {...props} />;
}
