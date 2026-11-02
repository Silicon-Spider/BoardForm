// Extra stroke icons for the Play page, drawn in the same style as @/components' Icon
// (24×24 grid, currentColor, 2px round strokes).
import type { SVGProps } from "react";

const PATHS = {
  download: "M12 4v11M7 10.5l5 5 5-5M5 20h14",
  upload: "M12 20V9M7 13.5l5-5 5 5M5 4h14",
  flag: "M6 21V4M6 4.5c3-1.6 5 1.4 8 0s3.5-.5 4 0v8.5c-.5-.5-1-1.4-4 0s-5-1.6-8 0",
  handshake: "M3 12l4-4 3 1 3-2 4 1 4 4M7 8l-3 6 4 4 2-1M17 8l3 6-6 5-5-5 3-3 3 2",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  stop: "M7 7h10v10H7z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  swap: "M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3",
  board: "M4 4h16v16H4zM4 12h16M12 4v16M4 8h4M8 4v16M16 4v16M4 16h16",
  terminal: "M4 6l5 5-5 5M11 18h9",
  graph: "M3 17l5-6 4 3 5-7 4 4M3 21h18",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
} as const;

export type PlayIconName = keyof typeof PATHS;

export function PlayIcon({ name, size = 16, className, ...rest }: Omit<SVGProps<SVGSVGElement>, "name"> & { name: PlayIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `cb-icon ${className}` : "cb-icon"}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
