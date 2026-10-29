import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

/**
 * The top-level error boundary. A render error anywhere in the
 * studio used to unmount the whole tree and leave a blank page; now it shows
 * what broke and a way out (reload, or retry): an error card centred on the
 * canvas with the message in mono.
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
      <div className="error-boundary-screen">
        <div className="error-boundary" role="alert">
          <span className="error-boundary-icon" aria-hidden="true">
            <AlertTriangle size={20} strokeWidth={1.75} />
          </span>
          <h1>Something went wrong</h1>
          <p className="error-boundary-hint">Agent Forge hit an error it could not recover from. Try again, or reload the Studio.</p>
          <pre className="error-boundary-message">{error.message}</pre>
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              <RotateCw aria-hidden="true" />
              Reload
            </button>
            <button type="button" className="btn" onClick={this.retry}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
