import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareSemver, parseGitHubRepo, parseSemver, UpdateChecker } from '../sidecars/meter/updater.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const tempDirs = [];
const servers = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-updater-test-'));
  tempDirs.push(dir);
  return dir;
}

function setupPluginDir(root, manifest) {
  const pluginDir = join(root, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return pluginDir;
}

async function startMockServer(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  servers.push(server);
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    await new Promise((r) => s.close(() => r()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('SemVer and repository helpers', () => {
  it('parses and compares SemVer including prerelease and v-prefix', () => {
    assert.equal(parseSemver('v0.1.0')?.normalized, '0.1.0');
    assert.equal(parseSemver('V1.2.10-beta.2+build99')?.normalized, '1.2.10-beta.2');
    assert.equal(parseSemver('invalid'), null);

    assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
    assert.equal(compareSemver('v0.1.10', '0.1.2'), 1);
    assert.equal(compareSemver('0.2.0-rc.1', '0.2.0'), -1);
    assert.equal(compareSemver('0.2.0-rc.2', '0.2.0-rc.10'), -1);
    assert.equal(compareSemver('0.2.0-alpha', '0.2.0-1'), 1);
    assert.equal(compareSemver('bad', '0.1.0'), null);
  });

  it('extracts GitHub owner/repo from repository object, string, or homepage', () => {
    assert.deepEqual(
      parseGitHubRepo({ repository: { type: 'git', url: 'https://github.com/AnTengye/agy-token-meter.git' } }),
      { owner: 'AnTengye', repo: 'agy-token-meter', htmlUrl: 'https://github.com/AnTengye/agy-token-meter' }
    );
    assert.deepEqual(
      parseGitHubRepo({ repository: 'https://github.com/foo/bar/' }),
      { owner: 'foo', repo: 'bar', htmlUrl: 'https://github.com/foo/bar' }
    );
    assert.deepEqual(
      parseGitHubRepo({ homepage: 'https://github.com/baz/qux' }),
      { owner: 'baz', repo: 'qux', htmlUrl: 'https://github.com/baz/qux' }
    );
    assert.equal(parseGitHubRepo({ homepage: 'https://example.com/foo' }), null);
  });
});

describe('UpdateChecker', () => {
  it('makes zero outbound requests by default (opt-in)', () => {
    const root = makeTempDir();
    const pluginDir = setupPluginDir(root, {
      name: 'token-meter',
      version: '0.1.0',
      repository: 'https://github.com/AnTengye/agy-token-meter.git',
    });
    const appDataDir = join(root, 'app_data');
    let calls = 0;

    const checker = new UpdateChecker({
      pluginDir,
      appDataDir,
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error('should_not_be_called');
      },
    });

    const status = checker.getStatus({ triggerBackgroundIfDue: true });
    assert.equal(calls, 0);
    assert.equal(status.autoCheck, false);
    assert.equal(status.hasUpdate, false);
    assert.equal(status.currentVersion, '0.1.0');
    assert.equal(status.checking, false);
  });

  it('checks mock GitHub release, caches ETag, and handles 304 Not Modified', async () => {
    const root = makeTempDir();
    const pluginDir = setupPluginDir(root, {
      name: 'token-meter',
      version: '0.1.0',
      repository: { type: 'git', url: 'https://github.com/AnTengye/agy-token-meter.git' },
    });
    const appDataDir = join(root, 'app_data');

    let hitCount = 0;
    let sawIfNoneMatch = null;
    const baseUrl = await startMockServer((req, res) => {
      hitCount += 1;
      if (req.url === '/releases/latest') {
        if (req.headers['if-none-match'] === '"etag-v020"') {
          sawIfNoneMatch = req.headers['if-none-match'];
          res.writeHead(304);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"etag-v020"' });
        res.end(
          JSON.stringify({
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/AnTengye/agy-token-meter/releases/tag/v0.2.0',
            body: '## Highlights\n- Faster overview scan\n- Lower memory usage',
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let fakeNow = 1_700_000_000_000;
    const checker = new UpdateChecker({
      pluginDir,
      appDataDir,
      env: { TOKEN_METER_RELEASE_API_URL: `${baseUrl}/releases/latest` },
      now: () => fakeNow,
      ttlMs: 10_000,
    });

    const s1 = await checker.checkNow({ force: true });
    assert.equal(hitCount, 1);
    assert.equal(s1.hasUpdate, true);
    assert.equal(s1.latestVersion, '0.2.0');
    assert.equal(s1.source, 'github-release');
    assert.match(s1.releaseNotes, /Faster overview scan/);

    // Within TTL and force=false: uses local state without network
    const sCached = await checker.checkNow({ force: false });
    assert.equal(hitCount, 1);
    assert.equal(sCached.latestVersion, '0.2.0');

    // Past TTL: sends If-None-Match and handles 304
    fakeNow += 20_000;
    const s2 = await checker.checkNow({ force: false });
    assert.equal(hitCount, 2);
    assert.equal(sawIfNoneMatch, '"etag-v020"');
    assert.equal(s2.latestVersion, '0.2.0');
    assert.equal(s2.checkedAt, fakeNow);
  });

  it('falls back to raw plugin.json when releases API returns 404 or 403', async () => {
    for (const statusCode of [404, 403]) {
      const root = makeTempDir();
      const pluginDir = setupPluginDir(root, {
        name: 'token-meter',
        version: '0.1.0',
        repository: 'https://github.com/AnTengye/agy-token-meter',
      });
      const appDataDir = join(root, 'app_data');

      const baseUrl = await startMockServer((req, res) => {
        if (req.url === '/releases/latest') {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'unavailable' }));
          return;
        }
        if (req.url === '/plugin.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: 'token-meter', version: '0.1.5' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const checker = new UpdateChecker({
        pluginDir,
        appDataDir,
        env: {
          TOKEN_METER_RELEASE_API_URL: `${baseUrl}/releases/latest`,
          TOKEN_METER_RAW_MANIFEST_URL: `${baseUrl}/plugin.json`,
        },
      });

      const st = await checker.checkNow({ force: true });
      assert.equal(st.hasUpdate, true);
      assert.equal(st.latestVersion, '0.1.5');
      assert.equal(st.source, 'plugin-json');
      assert.equal(st.lastError, null);
    }
  });

  it('dismisses current latest version and re-alerts when a newer version ships', async () => {
    const root = makeTempDir();
    const pluginDir = setupPluginDir(root, {
      name: 'token-meter',
      version: '0.1.0',
      repository: 'https://github.com/AnTengye/agy-token-meter',
    });
    const appDataDir = join(root, 'app_data');
    let remoteTag = 'v0.2.0';

    const baseUrl = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: remoteTag, html_url: 'https://github.com/AnTengye/agy-token-meter/releases' }));
    });

    const checker = new UpdateChecker({
      pluginDir,
      appDataDir,
      env: { TOKEN_METER_UPDATE_URL: `${baseUrl}/update` },
    });

    const s1 = await checker.checkNow({ force: true });
    assert.equal(s1.hasUpdate, true);
    assert.equal(s1.dismissed, false);

    const sDismissed = checker.dismissVersion();
    assert.equal(sDismissed.hasUpdate, true);
    assert.equal(sDismissed.dismissed, true);

    remoteTag = 'v0.3.0';
    const sNext = await checker.checkNow({ force: true });
    assert.equal(sNext.latestVersion, '0.3.0');
    assert.equal(sNext.dismissed, false);
  });

  it('persists autoCheck state under sidecar_data and triggers background check only when due', async () => {
    const root = makeTempDir();
    const pluginDir = setupPluginDir(root, {
      name: 'token-meter',
      version: '0.1.0',
      repository: 'https://github.com/AnTengye/agy-token-meter',
    });
    const appDataDir = join(root, 'app_data');

    let calls = 0;
    const baseUrl = await startMockServer((req, res) => {
      calls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.1.0' }));
    });

    const env = { TOKEN_METER_UPDATE_URL: `${baseUrl}/manifest.json` };
    const c1 = new UpdateChecker({ pluginDir, appDataDir, env, ttlMs: 60_000 });
    const afterSet = c1.setAutoCheck(true);
    assert.equal(afterSet.autoCheck, true);

    const stateFile = join(appDataDir, 'sidecar_data', 'token-meter', 'meter', 'update-state.json');
    assert.equal(existsSync(stateFile), true);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).autoCheck, true);

    // New instance picks up persisted autoCheck=true and triggers non-blocking check
    const c2 = new UpdateChecker({ pluginDir, appDataDir, env, ttlMs: 60_000 });
    const s2 = c2.getStatus({ triggerBackgroundIfDue: true });
    assert.equal(s2.autoCheck, true);
    assert.equal(s2.checking, true);

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls, 1);
    assert.equal(c2.getStatus().checking, false);
  });

  it('honors TOKEN_METER_UPDATE_CHECK=0 hard opt-out and TOKEN_METER_UPDATE_CHECK=1 override', async () => {
    const root = makeTempDir();
    const pluginDir = setupPluginDir(root, {
      name: 'token-meter',
      version: '0.1.0',
      repository: 'https://github.com/AnTengye/agy-token-meter',
    });
    const appDataDir = join(root, 'app_data');
    let calls = 0;

    const disabledChecker = new UpdateChecker({
      pluginDir,
      appDataDir,
      env: { TOKEN_METER_UPDATE_CHECK: '0' },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must_not_fetch');
      },
    });
    const res = await disabledChecker.checkNow({ force: true });
    assert.equal(calls, 0);
    assert.equal(res.disabledByEnv, true);
    assert.equal(res.autoCheck, false);

    const enabledChecker = new UpdateChecker({
      pluginDir,
      appDataDir,
      env: { TOKEN_METER_UPDATE_CHECK: '1' },
    });
    assert.equal(enabledChecker.getStatus().autoCheck, true);
  });

  it('preserves previous latestVersion on network error/timeout and detects symlink installs', async () => {
    const root = makeTempDir();
    const realPlugin = setupPluginDir(root, {
      name: 'token-meter',
      version: '0.1.0',
      repository: 'https://github.com/AnTengye/agy-token-meter',
    });
    const linkPlugin = join(root, 'token-meter-link');
    symlinkSync(realPlugin, linkPlugin, process.platform === 'win32' ? 'junction' : 'dir');
    const appDataDir = join(root, 'app_data');

    let failNext = false;
    const baseUrl = await startMockServer((req, res) => {
      if (failNext) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.2.1' }));
    });

    const checker = new UpdateChecker({
      pluginDir: linkPlugin,
      appDataDir,
      env: { TOKEN_METER_UPDATE_URL: `${baseUrl}/manifest.json` },
      timeoutMs: 300,
    });

    const okRes = await checker.checkNow({ force: true });
    assert.equal(okRes.isSymlinkInstall, true);
    assert.equal(okRes.latestVersion, '0.2.1');
    assert.equal(okRes.hasUpdate, true);

    failNext = true;
    const errRes = await checker.checkNow({ force: true });
    assert.equal(errRes.latestVersion, '0.2.1');
    assert.equal(errRes.hasUpdate, true);
    assert.ok(errRes.lastError);
  });

  it('supports CLI --check-update against mock update URL', async () => {
    const root = makeTempDir();
    const appDataDir = join(root, 'app_data');
    const baseUrl = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.9.9', changelog: 'CLI test release' }));
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(REPO_ROOT, 'sidecars', 'meter', 'main.mjs'), '--check-update'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ANTIGRAVITY_APP_DATA_DIR: appDataDir,
          TOKEN_METER_UPDATE_URL: `${baseUrl}/plugin.json`,
        },
      }
    );

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.currentVersion, '0.1.0');
    assert.equal(parsed.latestVersion, '0.9.9');
    assert.equal(parsed.hasUpdate, true);
  });
});
