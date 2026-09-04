import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Stops one broken component taking the whole window with it.
 *
 * Without a boundary, React unmounts the entire tree when any render throws -
 * the app goes blank with nothing on screen to explain it, and the only trace
 * is in a console nobody has open. A voice client that white-screens mid-call
 * is worse than one showing a degraded panel, because at least the panel says
 * what happened and offers a way back.
 *
 * `scope` names what was isolated, so the message can say which part failed
 * rather than implying everything did.
 */
interface Props {
  children: ReactNode;
  scope: string;
  /** Rendered instead of the default panel, for small non-critical regions. */
  quiet?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes to the terminal in development, where the main process mirrors the
    // renderer console.
    console.error(`[${this.props.scope}] render failed`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.quiet) {
      return (
        <div className="boundary boundary--quiet">
          <span className="legend">{this.props.scope} unavailable</span>
          <button className="linkish" onClick={this.reset}>
            Retry
          </button>
        </div>
      );
    }

    return (
      <div className="boundary">
        <div className="boundary__inner">
          <span className="legend">Something broke</span>
          <h2 className="empty__title">The {this.props.scope} stopped working</h2>
          <p className="empty__body">
            The rest of the app is still running, and your call is unaffected. Retrying re-renders
            this part; if it keeps failing, the details are in the terminal.
          </p>
          <p className="boundary__detail mono">{error.message}</p>
          <button className="btn btn--primary" onClick={this.reset}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
