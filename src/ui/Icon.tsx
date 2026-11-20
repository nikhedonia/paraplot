import type { ReactNode } from 'react';

export type IconName =
  | 'frame'
  | 'grid'
  | 'shadow'
  | 'ao'
  | 'plus'
  | 'minus'
  | 'reset'
  | 'chevron'
  | 'play'
  | 'pause'
  | 'trash'
  | 'arrowLeft'
  | 'eye'
  | 'eyeOff'
  | 'target'
  | 'tree'
  | 'logo';

const paths: Record<IconName, ReactNode> = {
  frame: (
    <>
      <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" />
      <path d="M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8" />
      <path d="M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" />
    </>
  ),
  grid: (
    <>
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
    </>
  ),
  shadow: (
    <>
      <circle cx="9" cy="9" r="4.5" />
      <path d="M8 20h9a3 3 0 0 0 3-3v-2" opacity="0.55" />
      <path d="M14.5 13.5A4.5 4.5 0 0 0 13.5 4.6" opacity="0.55" />
    </>
  ),
  ao: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 0 0 16" opacity="0.5" />
      <path d="M12 8a4 4 0 0 0 0 8" opacity="0.7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  reset: (
    <>
      <path d="M4 10a8 8 0 1 1 2.3 6" />
      <path d="M4 4v6h6" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  play: <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.2 7l.9 12.2h9.8L17.8 7" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </>
  ),
  eye: (
    <>
      <path d="M2.6 12S6 6.2 12 6.2 21.4 12 21.4 12 18 17.8 12 17.8 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4.2 8.2C3.1 9.6 2.6 12 2.6 12s3.4 5.8 9.4 5.8c1.5 0 2.8-.4 4-1" />
      <path d="M7.4 7.1C8.8 6.5 10.3 6.2 12 6.2c6 0 9.4 5.8 9.4 5.8s-.9 1.6-2.6 3" />
      <path d="M10.2 10.2a2.6 2.6 0 0 0 3.6 3.6" />
      <path d="M4 4l16 16" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  tree: (
    <>
      <path d="M6 4v16M6 8h5M6 14h5M6 20h5" />
      <rect x="11" y="6" width="9" height="4" rx="1" />
      <rect x="11" y="12" width="9" height="4" rx="1" />
      <rect x="11" y="18" width="9" height="4" rx="1" />
    </>
  ),
  pause: (
    <>
      <rect x="7.5" y="5.5" width="3" height="13" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5.5" width="3" height="13" rx="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  logo: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" opacity="0.6" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
