// Empty state (global .empty-state): what is missing and what to do next.
import type { ReactNode } from "react";
import "./EmptyState.css";

export interface EmptyStateProps {
  title: ReactNode;
  /** Explanation of what to do next. */
  description?: ReactNode;
  /** Call-to-action (usually a button). */
  action?: ReactNode;
  /** Decorative icon or illustration above the title. */
  icon?: ReactNode;
  /** Less padding, for panels. */
  compact?: boolean;
  children?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, compact, children, className }: EmptyStateProps) {
  return (
    <div className={["empty-state", "cb-empty", compact && "cb-empty--compact", className].filter(Boolean).join(" ")}>
      {icon && <div className="cb-empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {description && <p className="cb-empty-desc">{description}</p>}
      {children}
      {action && <div className="cb-empty-action">{action}</div>}
    </div>
  );
}
