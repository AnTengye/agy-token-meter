import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppDataDir, TokenMeterEngine, UUID_RE } from './engine.mjs';
import { UpdateChecker } from './updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const engine = new TokenMeterEngine();
const updater = new UpdateChecker({
  pluginDir: resolve(__dirname, '..', '..'),
  appDataDir: getAppDataDir(),
});

// CLI self-test mode:
//   node main.mjs --inspect <conversationId>
//   node main.mjs --overview [today|24h]
//   node main.mjs --check-update
const argv = process.argv.slice(2);
if (argv.includes('--inspect')) {
  const idx = argv.indexOf('--inspect');
  const cid = argv[idx + 1] || '';
  const t0 = performance.now();
  const snap = engine.getSessionSnapshot(cid);
  const t1 = performance.now();
  const snapHot = engine.getSessionSnapshot(cid, snap.etag || '');
  const t2 = performance.now();
  console.log(
    JSON.stringify(
      {
        coldMs: Number((t1 - t0).toFixed(2)),
        hotEtagMs: Number((t2 - t1).toFixed(2)),
        hotUnchanged: Boolean(snapHot.unchanged),
        snapshot: snap,
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (argv.includes('--overview')) {
  const idx = argv.indexOf('--overview');
  const range = argv[idx + 1] === '24h' ? '24h' : 'today';
  const data = engine.getOverview(range, true);
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

if (argv.includes('--check-update')) {
  const status = await updater.checkNow({ force: true });
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

// Sidecar server mode
const { SidecarApp, Response } = await import('sidecar_sdk');

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType,
        headers: { 'Cache-Control': 'no-cache' },
      }),
    'GET'
  );
}

app.api(
  '/api/session',
  (data) => {
    const conv = String(data.conversationId || app.config.conversationId || '').trim();
    if (!conv || !UUID_RE.test(conv)) {
      return {
        conversationId: conv || null,
        exists: false,
        mode: 'empty',
        error: conv ? 'invalid_conversation_id' : 'missing_conversation_id',
      };
    }
    const etag = typeof data.etag === 'string' ? data.etag : '';
    return engine.getSessionSnapshot(conv, etag);
  },
  'GET'
);

app.api(
  '/api/overview',
  (data) => {
    const range = data.range === '24h' ? '24h' : 'today';
    const force = data.force === '1' || data.force === 'true';
    return engine.getOverview(range, force);
  },
  'GET'
);

app.api('/api/update', () => updater.getStatus({ triggerBackgroundIfDue: true }), 'GET');
app.api('/api/update/check', (data) => updater.checkNow({ force: data?.force !== false }), 'POST');
app.api('/api/update/settings', (data) => updater.setAutoCheck(Boolean(data?.autoCheck)), 'POST');
app.api(
  '/api/update/dismiss',
  (data) => updater.dismissVersion(typeof data?.version === 'string' ? data.version : undefined),
  'POST'
);

await app.run();
