// Small stroke icons for the file tree (24×24 grid, currentColor), in the style of @/components Icon.
import type { SVGProps } from "react";

const PATHS = {
  chevron: "M9 6l6 6-6 6",
  folder: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  folderOpen: "M3 17.5v-10A1.5 1.5 0 0 1 4.5 6H9l2 2h7.5A1.5 1.5 0 0 1 20 9.5V11M3 17.5L5.6 11.9A1.5 1.5 0 0 1 7 11h13.3a1 1 0 0 1 .9 1.4l-2.4 5.7A1.5 1.5 0 0 1 17.4 19H4.5A1.5 1.5 0 0 1 3 17.5z",
  file: "M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  pencil: "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l3 3",
  flag: "M6 21V4M6 4h11l-2 4 2 4H6",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5",
  filePlus: "M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4M12 11v6M9 14h6",
} as const;

export type TreeIconName = keyof typeof PATHS;

export function TreeIcon({ name, size = 16, className, ...rest }: Omit<SVGProps<SVGSVGElement>, "name"> & { name: TreeIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
