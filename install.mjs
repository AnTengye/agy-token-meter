#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = resolve(
  process.env.AGY_PLUGIN_DIR || join(homedir(), '.gemini', 'config', 'plugins', 'token-meter')
);
const APP_DATA_DIR = resolve(
  process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity')
);

const args = process.argv.slice(2);
let action = 'install';
let linkMode = false;

for (const arg of args) {
  if (arg === 'install' || arg === 'uninstall' || arg === 'doctor') {
    action = arg;
  } else if (arg === '--link') {
    linkMode = true;
  } else if (arg === '-h' || arg === '--help') {
    console.log(
      'Usage: node install.mjs [install|uninstall|doctor] [--link]\n' +
        '  install     Install or update Token Meter into ~/.gemini/config/plugins/token-meter\n' +
        '  uninstall   Remove the installed plugin directory\n' +
        '  doctor      Verify files, node:sqlite, read-only engine, and live Sidecar port\n' +
        '  --link      Symlink local repository directory instead of copying'
    );
    process.exit(0);
  } else {
    console.error(`[token-meter][error] Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const log = (msg) => console.error(`[token-meter] ${msg}`);
const warn = (msg) => console.error(`[token-meter][warn] ${msg}`);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function detectLocalSource() {
  for (const dir of [__dirname, process.cwd()]) {
    if (existsSync(join(dir, 'plugin.json')) && existsSync(join(dir, 'sidecars', 'meter', 'main.mjs'))) {
      return resolve(dir);
    }
  }
  return null;
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function moveExistingWithUnlock(target, backup) {
  for (const rel of [['plugin.json'], ['sidecars', 'meter', 'sidecar.json']]) {
    try {
      rmSync(join(target, ...rel), { force: true });
    } catch {
      // ignore missing/locked manifest
    }
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(backup, { recursive: true, force: true });
      renameSync(target, backup);
      return true;
    } catch {
      sleepMs(500);
    }
  }
  return false;
}

function checkHttpAlive(port) {
  return new Promise((resolveAlive) => {
    const req = httpGet(`http://127.0.0.1:${port}/`, { timeout: 1500 }, (res) => {
      res.resume();
      resolveAlive(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolveAlive(false);
    });
    req.on('error', () => resolveAlive(false));
  });
}

async function doDoctor() {
  let ok = true;
  if (!existsSync(TARGET_DIR)) {
    warn(`Plugin is not installed at ${TARGET_DIR}`);
    return false;
  }

  const required = [
    'plugin.json',
    join('assets', 'logo.svg'),
    join('skills', 'token-meter', 'SKILL.md'),
    join('sidecars', 'meter', 'package.json'),
    join('sidecars', 'meter', 'sidecar.json'),
    join('sidecars', 'meter', 'engine.mjs'),
    join('sidecars', 'meter', 'main.mjs'),
    join('sidecars', 'meter', 'index.html'),
    join('sidecars', 'meter', 'styles.css'),
    join('sidecars', 'meter', 'app.js'),
  ];

  for (const rel of required) {
    const full = join(TARGET_DIR, rel);
    if (!existsSync(full)) {
      warn(`Missing required file: ${full}`);
      ok = false;
    }
  }
  if (ok) log(`Files OK: ${TARGET_DIR}`);

  // Verify node:sqlite and read-only engine
  try {
    await import('node:sqlite');
    log(`Node SQLite runtime OK: ${process.execPath} (${process.version})`);
    const mainScript = join(TARGET_DIR, 'sidecars', 'meter', 'main.mjs');
    const res = spawnSync(process.execPath, [mainScript, '--overview', 'today'], {
      encoding: 'utf8',
      env: { ...process.env, ANTIGRAVITY_APP_DATA_DIR: APP_DATA_DIR },
    });
    if (res.status === 0) {
      const parsed = JSON.parse(res.stdout);
      log(`Engine read-only test OK: ${JSON.stringify(parsed.totals)}`);
    } else {
      warn(`Engine read-only test failed: ${res.stderr || res.stdout}`);
      ok = false;
    }
  } catch (err) {
    warn(`node:sqlite check failed (${process.version}): ${err.message}`);
    ok = false;
  }

  const sidecarLog = join(APP_DATA_DIR, 'sidecar_data', 'token-meter', 'meter', 'logs', 'sidecar.log');
  if (existsSync(sidecarLog)) {
    const text = readFileSync(sidecarLog, 'utf8');
    const matches = [...text.matchAll(/127\.0\.0\.1:(\d+)/g)];
    const port = matches.length ? matches[matches.length - 1][1] : null;
    if (port) {
      const alive = await checkHttpAlive(port);
      if (alive) log(`Sidecar HTTP server is LIVE on 127.0.0.1:${port}`);
      else warn(`Last logged port ${port} is not responding right now (Antigravity may still be reloading).`);
    } else {
      log(`Sidecar log present at ${sidecarLog}`);
    }
  } else {
    log('Sidecar log not found yet (Antigravity starts it automatically once enabled).');
  }

  return ok;
}

async function doInstall() {
  const srcDir = detectLocalSource();
  if (!srcDir) {
    console.error('[token-meter][error] install.mjs must be executed from a local agy-token-meter directory.');
    process.exit(1);
  }
  log(`Using local source: ${srcDir}`);

  const pluginsDir = dirname(TARGET_DIR);
  // Stage outside plugins/ on the same volume so Antigravity never loads a partial directory.
  const stageRoot = dirname(pluginsDir);
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(stageRoot, { recursive: true });

  const backupDir = join(stageRoot, `.token-meter-backup-${process.pid}`);

  if (linkMode) {
    if (isSymlink(TARGET_DIR)) {
      unlinkSync(TARGET_DIR);
    } else if (existsSync(TARGET_DIR)) {
      if (!moveExistingWithUnlock(TARGET_DIR, backupDir)) {
        console.error(`[token-meter][error] Failed to replace existing ${TARGET_DIR} (directory in use).`);
        process.exit(1);
      }
      rmSync(backupDir, { recursive: true, force: true });
    }
    symlinkSync(srcDir, TARGET_DIR, process.platform === 'win32' ? 'junction' : 'dir');
    log(`Linked ${TARGET_DIR} -> ${srcDir}`);
  } else {
    const stageDir = join(stageRoot, `.token-meter-stage-${process.pid}`);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    try {
      for (const file of ['plugin.json', 'README.md', 'LICENSE', 'install.sh', 'install.ps1', 'install.mjs']) {
        const srcFile = join(srcDir, file);
        if (existsSync(srcFile)) {
          cpSync(srcFile, join(stageDir, file));
        }
      }
      if (process.platform !== 'win32' && existsSync(join(stageDir, 'install.sh'))) {
        chmodSync(join(stageDir, 'install.sh'), 0o755);
      }
      for (const sub of ['assets', 'skills', 'sidecars']) {
        const srcSub = join(srcDir, sub);
        if (existsSync(srcSub)) {
          cpSync(srcSub, join(stageDir, sub), {
            recursive: true,
            filter: (p) => !p.endsWith('.DS_Store'),
          });
        }
      }

      if (isSymlink(TARGET_DIR)) {
        unlinkSync(TARGET_DIR);
      } else if (existsSync(TARGET_DIR)) {
        if (!moveExistingWithUnlock(TARGET_DIR, backupDir)) {
          console.error(`[token-meter][error] Failed to move existing ${TARGET_DIR} to backup (directory in use).`);
          process.exit(1);
        }
      }

      try {
        renameSync(stageDir, TARGET_DIR);
        rmSync(backupDir, { recursive: true, force: true });
      } catch (err) {
        if (existsSync(backupDir) && !existsSync(TARGET_DIR)) {
          try {
            renameSync(backupDir, TARGET_DIR);
          } catch {
            // ignore rollback error
          }
        }
        throw err;
      }
      log(`Installed atomically to ${TARGET_DIR}`);
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  log('Note: ~/.gemini/config/config.json was not modified; Antigravity 2.0 hot-loads plugins automatically.');
  await doDoctor();
}

function doUninstall() {
  if (!TARGET_DIR || TARGET_DIR === '/' || /^[A-Za-z]:\\?$/.test(TARGET_DIR)) {
    console.error(`[token-meter][error] Unsafe TARGET_DIR: ${TARGET_DIR}`);
    process.exit(1);
  }
  if (!existsSync(TARGET_DIR) && !isSymlink(TARGET_DIR)) {
    log(`Nothing to remove (${TARGET_DIR} does not exist).`);
    return;
  }
  if (isSymlink(TARGET_DIR)) {
    unlinkSync(TARGET_DIR);
  } else {
    const stageRoot = dirname(dirname(TARGET_DIR));
    const backupDir = join(stageRoot, `.token-meter-uninstall-${process.pid}`);
    if (moveExistingWithUnlock(TARGET_DIR, backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
    } else {
      rmSync(TARGET_DIR, { recursive: true, force: true });
    }
  }
  log(`Removed ${TARGET_DIR}`);
}

if (action === 'install') {
  await doInstall();
} else if (action === 'uninstall') {
  doUninstall();
} else if (action === 'doctor') {
  const ok = await doDoctor();
  process.exit(ok ? 0 : 1);
}
