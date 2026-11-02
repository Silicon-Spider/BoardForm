// Extra stroke icons for the Engine Library and Settings pages (same 24×24 grid and look as the
// shared <Icon> from @/components, which only has the board/editor icons).
import type { ReactNode, SVGProps } from "react";

const circle = (cx: number, cy: number, r: number) => <circle cx={cx} cy={cy} r={r} />;

const SHAPES = {
  upload: <path d="M12 15V4M7 9l5-5 5 5M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />,
  more: (
    <>
      {circle(5, 12, 1.3)}
      {circle(12, 12, 1.3)}
      {circle(19, 12, 1.3)}
    </>
  ),
  puzzle: <path d="M5 8h3.5a2 2 0 1 1 4 0H16v3.5a2 2 0 1 1 0 4V19H5z" />,
  code: <path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 5.5l-3 13" />,
  layers: <path d="M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4" />,
  pencil: <path d="M13 20h8M16.5 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4z" />,
  network: (
    <>
      <path d="M7 7.4l3.4 3.2M7 16.6l3.4-3.2M14 12h3" />
      {circle(5.5, 6, 2)}
      {circle(5.5, 18, 2)}
      {circle(12, 12, 2)}
      {circle(19, 12, 2)}
    </>
  ),
  chip: (
    <>
      <rect x={6} y={6} width={12} height={12} rx={2} />
      <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3M10 10h4v4h-4z" />
    </>
  ),
  swords: <path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2" />,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />,
  sun: (
    <>
      {circle(12, 12, 4)}
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: (
    <>
      <rect x={3} y={4} width={18} height={12} rx={2} />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  shield: <path d="M12 3l7 3v5.5c0 4.3-3 8-7 9.5-4-1.5-7-5.2-7-9.5V6zM9 12l2 2 4-4" />,
  database: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c.9 0 1.5-.6 1.5-1.4 0-.4-.2-.8-.4-1.1-.3-.3-.5-.7-.5-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3z" />
      {circle(7.5, 11, 1)}
      {circle(10.5, 7, 1)}
      {circle(15, 7.5, 1)}
    </>
  ),
  refresh: <path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4" />,
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  warning: <path d="M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />,
} satisfies Record<string, ReactNode>;

export type PageIconName = keyof typeof SHAPES;

export interface PageIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: PageIconName;
  size?: number;
}

export function PageIcon({ name, size = 16, className, ...rest }: PageIconProps) {
  const filled = name === "more";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `cb-icon ${className}` : "cb-icon"}
      {...rest}
    >
      {SHAPES[name]}
    </svg>
  );
}
