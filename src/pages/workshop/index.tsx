// Workshop page (#/engines/:id, optional ?tab=<id>&file=<path>): edit, build and test an engine.
import { useRef } from "react";
import { Link, type PageProps } from "@/app/router";
import { EmptyState, Spinner } from "@/components";
import { useEngine } from "@/storage";
import type { EngineRecord } from "@/types";
import { Workshop } from "./Workshop";
import "./workshop.css";

export default function WorkshopPage({ params, query }: PageProps) {
  const id = params.id ?? "";
  const engine = useEngine(id);
  // Keep showing the engine during a transient re-read (undefined) of a record we already had.
  const last = useRef<EngineRecord | null>(null);
  if (engine) last.current = engine;
  const shown = engine === undefined && last.current?.id === id ? last.current : engine;

  if (shown === undefined) {
    return (
      <div className="page-full workshop workshop-center">
        <Spinner size={22} label="Opening the engine…" />
      </div>
    );
  }
  if (shown === null) {
    return (
      <div className="page">
        <EmptyState
          title="Engine not found"
          description="It may have been deleted, or the link is wrong."
          action={
            <Link to="/engines" className="btn btn-primary">
              Back to your engines
            </Link>
          }
        />
      </div>
    );
  }
  return <Workshop key={shown.id} stored={shown} query={query} />;
}
