// Extra stroke icons for the Lab (same 24×24 grid and look as @/components Icon).
import type { SVGProps } from "react";

const PATHS = {
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  stop: "M7 7h10v10H7z",
  pauseCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 9v6M14 9v6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  // A neuron with three inputs.
  network:
    "M3 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM3 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM3 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM16.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0zM7 5.8l9.6 5.4M7 12h9.5M7 18.2l9.6-5.4",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  loop: "M4 11a8 8 0 0 1 14-4.6L20 8M20 3v5h-5M20 13a8 8 0 0 1-14 4.6L4 16M4 21v-5h5",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5",
  merge: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
  chart: "M4 19h16M6 15l4-5 4 3 5-7",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  widen: "M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4",
  layers: "M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
  engine: "M9 21h8M10 17h6l1 4H9l1-4zM8 7l4-4 5 3-1 4 2 3-3 4h-5l-2-5 2-3-2-2z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  dice: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 8.5h.01M15.5 15.5h.01M12 12h.01",
} as const;

export type LabIconName = keyof typeof PATHS;

/** Icons drawn as dots need a heavier stroke to read at 16 px. */
const HEAVY: ReadonlySet<LabIconName> = new Set<LabIconName>(["more"]);

export interface LabIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: LabIconName;
  size?: number;
}

export function LabIcon({ name, size = 16, className, ...rest }: LabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={HEAVY.has(name) ? 3.2 : 2}
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
