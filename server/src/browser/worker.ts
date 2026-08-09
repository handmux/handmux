import { createBrowserWorkerServer } from './workerServer.js';
import { installHammerheadWebSocketUpgradeCompat } from './hammerheadCompat.js';

const internalToken = process.env.HANDMUX_BROWSER_INTERNAL_TOKEN;
const previewDomain = process.env.HANDMUX_PREVIEW_DOMAIN || null;
const handmuxOrigin = process.env.HANDMUX_BROWSER_CONTROL_ORIGIN || 'http://127.0.0.1';

type BrowserWorker = Awaited<ReturnType<typeof createBrowserWorkerServer>>;
let worker: BrowserWorker | null = null;
let shutdownPromise: Promise<void> | null = null;

async function shutdown(code = 0): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      await worker?.close();
      process.exit(code);
    })();
  }
  return shutdownPromise;
}

process.once('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
process.once('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
process.once('disconnect', () => { shutdown().catch(() => process.exit(1)); });

try {
  installHammerheadWebSocketUpgradeCompat();
  worker = await createBrowserWorkerServer({ internalToken, previewDomain, handmuxOrigin });
  process.send?.({ type: 'handmux-browser-ready', port: worker.port });
} catch (error) {
  console.error(`[handmux] browser worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
