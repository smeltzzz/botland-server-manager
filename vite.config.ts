import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The shipped CSP has no WebSocket origin. Vite's HMR client still needs one,
// so widen it only for the dev server, never for `vite build`.
const devCsp = {
  name: 'botland-dev-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    return html.replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173");
  },
};

export default defineConfig({
  plugins: [react(), devCsp],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/release/**', '**/dist/**'] } },
});
