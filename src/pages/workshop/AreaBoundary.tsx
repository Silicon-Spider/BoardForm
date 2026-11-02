// Error boundary for one area of the Workshop (the main editor, a side-panel tab): if it crashes,
// that area shows the error with a Retry button and the rest of the page keeps working — edits
// already typed are safe in the autosave draft.
import { Component, type ReactNode } from "react";

interface Props {
  /** What the area is, for the message ("The code editor"). */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AreaBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`[workshop] ${this.props.label} crashed:`, error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="workshop-crash" role="alert">
        <div className="callout danger">
          <strong>{this.props.label} stopped working.</strong>
          <p className="small muted">Your work is saved. {error.message}</p>
          <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
