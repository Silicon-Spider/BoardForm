// Settings & data (route "#/settings"; "?section=<id>" scrolls to a section). Panels for
// appearance, engine defaults, storage / backups, the danger zone and credits, with a section nav
// on wide screens. Every control saves immediately.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PageProps } from "@/app/router";
import { Icon } from "@/components";
import { PageIcon } from "@/pages/engines/icons";
import { cx } from "@/pages/engines/ui";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { DangerZone } from "./DangerZone";
import { PerformanceSection } from "./PerformanceSection";
import { StorageSection } from "./StorageSection";
import "./settings.css";

const SECTIONS: ReadonlyArray<{ id: string; label: string; icon: ReactNode }> = [
  { id: "appearance", label: "Appearance", icon: <PageIcon name="palette" size={15} /> },
  { id: "engines", label: "Engines & performance", icon: <PageIcon name="sliders" size={15} /> },
  { id: "storage", label: "Storage & data", icon: <PageIcon name="database" size={15} /> },
  { id: "danger", label: "Danger zone", icon: <PageIcon name="warning" size={15} /> },
  { id: "about", label: "About & credits", icon: <Icon name="info" size={15} /> },
];

const sectionElement = (id: string) => document.getElementById(`settings-${id}`);

/** The section whose top has scrolled past the upper part of the viewport (scroll-spy). */
function useActiveSection(rootRef: RefObject<HTMLElement | null>): [string, (id: string) => void] {
  const [active, setActive] = useState(SECTIONS[0].id);
  const pinned = useRef<{ id: string; until: number } | null>(null);

  useEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>(".app-main") ?? null;
    const update = () => {
      // While a nav click scrolls smoothly, keep the clicked section highlighted.
      if (pinned.current && performance.now() < pinned.current.until) return;
      pinned.current = null;
      const line = (scroller?.getBoundingClientRect().top ?? 0) + 120;
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = sectionElement(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    update();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [rootRef]);

  const jumpTo = useCallback((id: string) => {
    const el = sectionElement(id);
    if (!el) return;
    pinned.current = { id, until: performance.now() + 900 };
    setActive(id);
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    // Move keyboard focus to the section so Tab continues there.
    el.focus({ preventScroll: true });
  }, []);

  return [active, jumpTo];
}

export default function SettingsPage({ query }: PageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, jumpTo] = useActiveSection(rootRef);
  // Remounting the data panels after "Delete all data" resets their local state (results, drafts).
  const [generation, setGeneration] = useState(0);

  const requested = query.get("section");
  useEffect(() => {
    if (requested && SECTIONS.some((s) => s.id === requested)) jumpTo(requested);
  }, [requested, jumpTo]);

  // The window title names the page, as the Workshop and Help do.
  useEffect(() => {
    const previous = document.title;
    document.title = "Settings · Chess Builder";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="page settings-page" ref={rootRef}>
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">Appearance, engine defaults and your data. Changes are saved automatically.</p>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={cx("settings-nav-link", active === s.id && "is-active", s.id === "danger" && "settings-nav-link--danger")}
                  aria-current={active === s.id ? "true" : undefined}
                  onClick={() => jumpTo(s.id)}
                >
                  {s.icon}
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-sections" key={generation}>
          <AppearanceSection />
          <PerformanceSection />
          <StorageSection />
          <DangerZone onDeleted={() => setGeneration((g) => g + 1)} />
          <AboutSection />
        </div>
      </div>
    </div>
  );
}
