import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

/**
 * Eve DUI-F3: the top-level error boundary. A render error anywhere in the
 * studio used to unmount the whole tree and leave a blank page; now it shows
 * what broke and a way out (retry, or reload).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Agent Forge crashed while rendering:', error, info.componentStack);
  }

  private readonly retry = (): void => this.setState({ error: undefined });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h1>Something went wrong</h1>
        <p>Agent Forge hit an error it could not recover from:</p>
        <pre>{error.message}</pre>
        <div className="error-boundary-actions">
          <button className="btn btn-primary" onClick={this.retry}>
            Try again
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
