import { Suspense, useEffect, useRef, type RefObject } from "react";
import { AppHeader } from "./AppHeader";
import { useApplyBoardTheme } from "./preferences";
import { useRoute } from "./router";
import { documentTitleFor, resolveRoute } from "./routes";
import { DatabaseBanner, ErrorBoundary, NotFoundPage, PageFallback } from "./ShellStates";
import { Toaster } from "./toast";

/**
 * Sets the route's default title ("Arena · BoardForm"). It renders before the page, so its effect
 * runs first and a page that sets a more specific title in its own effect (Workshop, Help,
 * Settings) wins.
 */
function DocumentTitle({ path }: { path: string }) {
  useEffect(() => {
    document.title = documentTitleFor(path);
  }, [path]);
  return null;
}

/** "Skip to content" for keyboard users: the first stop in the tab order, visible on focus. */
function SkipLink({ target }: { target: RefObject<HTMLElement | null> }) {
  const skip = () => {
    const main = target.current;
    if (!main) return;
    // Focusable only for this jump, so clicks inside the page never move focus to <main>.
    main.setAttribute("tabindex", "-1");
    main.focus();
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
  };
  return (
    <button type="button" className="app-skip-link" onClick={skip}>
      Skip to content
    </button>
  );
}

export default function App() {
  useApplyBoardTheme();
  const route = useRoute();
  const resolved = resolveRoute(route.path);
  const section = resolved?.def.section ?? "";
  const Page = resolved?.def.component;
  const mainRef = useRef<HTMLElement>(null);

  return (
    <div className="app">
      <SkipLink target={mainRef} />
      <AppHeader section={section} />
      <DatabaseBanner />
      <DocumentTitle path={route.path} />
      <main id="main-content" className="app-main" ref={mainRef}>
        <ErrorBoundary resetKey={route.path}>
          {/* Keyed per page: without the key, React keeps the previous page mounted (hidden) while
              the next page's code loads, and its unmount effects (saving drafts, restoring the
              window title) would then run after the new page has started. */}
          <Suspense key={resolved?.def.page ?? "not-found"} fallback={<PageFallback />}>
            {Page && resolved ? <Page params={resolved.params} query={route.query} /> : <NotFoundPage path={route.path} />}
          </Suspense>
        </ErrorBoundary>
      </main>
      <Toaster />
    </div>
  );
}
