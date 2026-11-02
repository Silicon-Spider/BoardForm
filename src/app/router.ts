// Minimal hash router: routes look like "#/engines/123?tab=code".
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";

export interface Route {
  /** Path without the leading '#', always starting with '/'. */
  path: string;
  segments: string[];
  query: URLSearchParams;
}

/** Props every page component receives. */
export interface PageProps {
  params: Record<string, string>;
  query: URLSearchParams;
}

/** decodeURIComponent that keeps a malformed escape ("%E0") as typed instead of throwing. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseHash(hash: string): Route {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("/")) raw = "/" + raw;
  const qIndex = raw.indexOf("?");
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const search = qIndex >= 0 ? raw.slice(qIndex + 1) : "";
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return {
    path: normalized || "/",
    segments: normalized.split("/").filter(Boolean).map(safeDecode),
    query: new URLSearchParams(search),
  };
}

let current: Route = parseHash(typeof location !== "undefined" ? location.hash : "");
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    current = parseHash(location.hash);
    listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getRoute(): Route {
  return current;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute, getRoute);
}

/** Navigate to a path such as "/play?engine=abc". */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = "#" + (to.startsWith("/") ? to : "/" + to);
  if (opts.replace) {
    history.replaceState(null, "", target);
    current = parseHash(target);
    listeners.forEach((l) => l());
  } else if (location.hash !== target) {
    location.hash = target;
  }
}

/** Update query parameters of the current route without adding a history entry. */
export function setQuery(params: Record<string, string | null | undefined>): void {
  const q = new URLSearchParams(current.query);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const qs = q.toString();
  navigate(current.path + (qs ? "?" + qs : ""), { replace: true });
}

/** Match "/engines/:id" against a path; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = safeDecode(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function href(to: string): string {
  return "#" + (to.startsWith("/") ? to : "/" + to);
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children?: ReactNode;
}

export function Link({ to, children, ...rest }: LinkProps) {
  return createElement("a", { ...rest, href: href(to) }, children);
}
