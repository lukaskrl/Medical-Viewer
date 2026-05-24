import React from 'react';
import type { IconProps } from '../types';

export const TabAIModels = (props: IconProps) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 22 22"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <g
      fill="none"
      fillRule="evenodd"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect
        x="5"
        y="5"
        width="12"
        height="12"
        rx="2"
      />
      <path d="M2.5 8.5h2.5M2.5 13.5h2.5M17 8.5h2.5M17 13.5h2.5M8.5 2.5v2.5M13.5 2.5v2.5M8.5 17v2.5M13.5 17v2.5" />
      <text
        x="11"
        y="13.4"
        textAnchor="middle"
        fontSize="5.2"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="700"
        stroke="none"
        fill="currentColor"
      >
        AI
      </text>
    </g>
    <path
      d="M0 0h22v22H0z"
      fill="none"
    />
  </svg>
);

export default TabAIModels;
