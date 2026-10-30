'use client';

// Shared render-error boundary for the kiosk dashboards (app/page.tsx and
// app/12.3display/page.tsx). Each page passes its own fallback and its own
// error reporter (the page's reportClientError -> /api/errors pipeline).
//
// Plain .ts (no JSX) so `node --test` can import it with native type
// stripping.

import { Component, type ErrorInfo, type ReactNode } from 'react';

export type DashboardErrorBoundaryProps = {
  children?: ReactNode;
  fallback: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
};

type State = { hasError: boolean };

export class DashboardErrorBoundary extends Component<DashboardErrorBoundaryProps, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export default DashboardErrorBoundary;
