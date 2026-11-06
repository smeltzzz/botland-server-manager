import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function StartupError({ detail }: { detail: string }) {
  return (
    <div className="loading-screen startup-error" role="alert">
      <div className="brand-symbol"><span /><span /><span /></div>
      <strong>botLANd could not connect to its desktop process.</strong>
      <p>{detail}</p>
      <p>Close this window and reopen botLANd. If the problem continues, reinstall the app.</p>
    </div>
  );
}

function renderStartupError(detail: string) {
  const element = document.getElementById('root');
  if (!element) return;
  ReactDOM.createRoot(element).render(
    <React.StrictMode><StartupError detail={detail} /></React.StrictMode>,
  );
}

// Without a boundary, one render-time exception unmounts the whole tree and the
// window stays blank with no message and no way back. Reloading re-reads state
// from the main process, which is the owner of every durable value.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // Diagnostics stay in the renderer console; nothing is sent anywhere.
    console.error('botLANd interface error', error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const detail = `${this.state.error.name}: ${this.state.error.message}`.slice(0, 400);
    return (
      <div className="loading-screen startup-error" role="alert">
        <div className="brand-symbol"><span /><span /><span /></div>
        <strong>botLANd hit an unexpected interface error.</strong>
        <p>Your servers are unaffected: a running server keeps running, and no configuration was written.</p>
        <p>{detail}</p>
        <p>Reload the interface to continue. If it happens again, copy diagnostics from the dashboard afterward and report the message above.</p>
        <button className="button primary-button" onClick={() => window.location.reload()}>Reload interface</button>
      </div>
    );
  }
}

async function mount() {
  // Browser previews use simulated data. The desktop preload always takes precedence.
  if (!window.manager) {
    if (import.meta.env.DEV) {
      try {
        const { createDemoManager } = await import('./demo');
        window.manager = createDemoManager();
      } catch {
        renderStartupError('The browser preview could not be loaded.');
        return;
      }
    } else {
      renderStartupError('The secure bridge to the local server manager did not load.');
      return;
    }
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>,
  );
}
void mount().catch(() => renderStartupError('The application could not start.'));
