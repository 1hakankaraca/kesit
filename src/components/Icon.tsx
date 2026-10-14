/** Çizgi ikon seti (24'lük ızgara, 1.8 kalınlık). Emoji kullanılmaz. */
const PATHS = {
  library: 'M4 5h4v14H4zM10 5h4v14h-4zM16.5 5.5l3.4-.9 3.6 13.6-3.4.9z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  film: 'M3 4h18v16H3zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4',
  live: 'M12 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.4 9.4 0 0 1 0-13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2',
  record: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 21zM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.6-4.6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  stop: 'M6 6h12v12H6z',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2',
  check: 'M4.5 12.5l5 5 10-11',
  x: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.4l1.4-1.9M20 20v-4.5h-4.5',
  plus: 'M12 5v14M5 12h14',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  chevron: 'M9 6l6 6-6 6',
  vertical: 'M7 2.5h10v19H7zM11 18.5h2',
  horizontal: 'M2.5 5h19v12h-19zM8 21h8M12 17v4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v5M16 3v5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5',
  folder: 'M3 6h6l2 2h10v11H3z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  phone: 'M7 2.5h10v19H7zM11 18.5h2',
  wifi: 'M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19h.01',
  key: 'M15 9a4 4 0 1 1-1.2-2.8M14 10l7 7v3h-3v-2h-2v-2h-2l-1.4-1.4',
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  music: 'M9 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 15V5l10-2v10',
  split: 'M12 3v18M5 8l4 4-4 4M19 8l-4 4 4 4',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  volume: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 9v6h4l5 4V5L8 9zM16 9l5 6M21 9l-5 6',
  crop: 'M6 2v16h16M2 6h16v16',
  move: 'M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4',
  cpu: 'M7 7h10v10H7zM4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3',
  disk: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  memory: 'M4 8h16v8H4zM8 8v8M12 8v8M16 8v8M4 12h16M6 16v2M18 16v2M6 6v2M18 6v2',
  export: 'M12 3v12M8 7l4-4 4 4M4 14v6h16v-6',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const filled = name === 'play' || name === 'pause' || name === 'stop';
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
