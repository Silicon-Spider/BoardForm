// Icons of the app's top navigation (24×24 stroke icons in currentColor, the same look as the
// shared <Icon> from @/components).
import type { ReactNode } from "react";

const SHAPES = {
  // Engines: a chip (the engines are compiled WebAssembly modules).
  engines: (
    <>
      <rect x={6} y={6} width={12} height={12} rx={2} />
      <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3M10 10h4v4h-4z" />
    </>
  ),
  // Play: a pawn.
  play: (
    <>
      <circle cx={12} cy={6} r={2.6} />
      <path d="M9.6 10.6h4.8M10.6 10.6c0 3-.9 5.3-2.4 7.4h7.6c-1.5-2.1-2.4-4.4-2.4-7.4M6.5 21h11l-.9-3H7.4z" />
    </>
  ),
  // Arena: crossed swords.
  arena: <path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2" />,
  // NNUE Lab: a flask.
  lab: <path d="M9 3h6M10 3v6.2L4.6 18.4A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3M7.2 15h9.6" />,
  help: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.3-1.2 1-1.2 1.8v.5M12 17h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx={12} cy={12} r={3} />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  alert: <path d="M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />,
  compass: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type NavIconName = keyof typeof SHAPES;

export function NavIcon({ name, size = 18, className }: { name: NavIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `app-icon ${className}` : "app-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
