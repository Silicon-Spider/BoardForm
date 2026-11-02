// The app's top bar. One row from 760 px up (Help and Settings shrink to icons below 1080 px);
// below 760 px a second row holds the four main destinations as equal-width tabs, so every page
// and the background-work indicator stay reachable down to 320 px. Layout lives in global.css.
import { ActivityIndicator } from "./ActivityIndicator";
import { NavIcon, type NavIconName } from "./navIcons";
import { Link } from "./router";

export interface NavItem {
  to: string;
  label: string;
  /** Route section (see ROUTES) that marks this link as the current page. */
  section: string;
  icon: NavIconName;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/engines", label: "Engines", section: "engines", icon: "engines" },
  { to: "/play", label: "Play", section: "play", icon: "play" },
  { to: "/arena", label: "Arena", section: "arena", icon: "arena" },
  { to: "/lab", label: "NNUE Lab", section: "lab", icon: "lab" },
];

export const UTILITY_NAV: readonly NavItem[] = [
  { to: "/help", label: "Help", section: "help", icon: "help" },
  { to: "/settings", label: "Settings", section: "settings", icon: "settings" },
];

function NavLink({ item, current }: { item: NavItem; current: boolean }) {
  return (
    <Link
      to={item.to}
      className={`app-nav-link ${current ? "active" : ""}`}
      aria-current={current ? "page" : undefined}
      // Tooltip for the icon-only state (CSS shows it on hover / keyboard focus when the label is hidden).
      data-tip={item.label}
    >
      <NavIcon name={item.icon} />
      <span className="app-nav-label">{item.label}</span>
    </Link>
  );
}

export function AppHeader({ section }: { section: string }) {
  return (
    <header className="app-nav">
      <Link to="/engines" className="app-brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span className="app-brand-name">BoardForm</span>
      </Link>
      <nav className="app-nav-links" aria-label="Main">
        {PRIMARY_NAV.map((n) => (
          <NavLink key={n.to} item={n} current={section === n.section} />
        ))}
      </nav>
      <div className="app-nav-spacer" />
      <ActivityIndicator />
      <nav className="app-nav-utility" aria-label="Help and settings">
        {UTILITY_NAV.map((n) => (
          <NavLink key={n.to} item={n} current={section === n.section} />
        ))}
      </nav>
    </header>
  );
}
