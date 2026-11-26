import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

const SEMVER_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const GH_URL_RE = /^(?:git\+)?https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i;

/**
 * Parse a SemVer string (with optional leading `v` and build metadata).
 * Returns null when invalid.
 */
export function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = SEMVER_RE.exec(trimmed);
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  const patch = Number.parseInt(m[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const pre = m[4] ? m[4].split('.').filter(Boolean) : [];
  if (m[4] && pre.length === 0) return null;
  return { major, minor, patch, pre, normalized: `${major}.${minor}.${patch}${pre.length ? `-${pre.join('.')}` : ''}` };
}

/**
 * Compare two SemVer strings. Returns -1, 0, 1, or null if either is invalid.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const na = Number.parseInt(ai, 10);
      const nb = Number.parseInt(bi, 10);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Extract GitHub owner/repo metadata from plugin.json repository or homepage fields.
 */
export function parseGitHubRepo(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const candidates = [];
  if (typeof manifest.repository === 'string') {
    candidates.push(manifest.repository);
  } else if (manifest.repository && typeof manifest.repository === 'object' && typeof manifest.repository.url === 'string') {
    candidates.push(manifest.repository.url);
  }
  if (typeof manifest.homepage === 'string') {
    candidates.push(manifest.homepage);
  }

  for (const raw of candidates) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    const m = GH_URL_RE.exec(trimmed);
    if (m) {
      const owner = m[1];
      const repo = m[2];
      if (owner && repo) {
        return { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}` };
      }
    }
  }
  return null;
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

function summarizeNotes(raw, maxLen = 160) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function defaultState() {
  return {
    schemaVersion: 1,
    autoCheck: false,
    lastCheckedAt: 0,
    latestVersion: null,
    releaseUrl: null,
    releaseNotes: '',
    source: null,
    etag: null,
    dismissedVersion: null,
    lastError: null,
  };
}

/**
 * Lightweight, opt-in version checker that stores runtime state under sidecar_data
 * and reads current metadata from plugin.json as the single source of truth.
 */
export class UpdateChecker {
  #pluginDir;
  #statePath;
  #env;
  #fetchImpl;
  #now;
  #ttlMs;
  #timeoutMs;
  #failureCooldownMs;
  #currentVersion;
  #repoInfo;
  #isSymlinkInstall;
  #state = null;
  #inflight = null;
  #lastAttemptAt = 0;

  constructor({
    pluginDir,
    appDataDir,
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    failureCooldownMs = DEFAULT_FAILURE_COOLDOWN_MS,
  }) {
    this.#pluginDir = pluginDir;
    this.#statePath = join(appDataDir, 'sidecar_data', 'token-meter', 'meter', 'update-state.json');
    this.#env = env;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#timeoutMs = timeoutMs;
    this.#failureCooldownMs = failureCooldownMs;

    const manifest = this.#readManifest();
    const parsedVer = parseSemver(manifest?.version);
    this.#currentVersion = parsedVer ? parsedVer.normalized : String(manifest?.version || '0.0.0');
    this.#repoInfo = parseGitHubRepo(manifest);
    this.#isSymlinkInstall = this.#detectSymlink(pluginDir);
  }

  #readManifest() {
    try {
      const raw = readFileSync(join(this.#pluginDir, 'plugin.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  #detectSymlink(dir) {
    try {
      return lstatSync(dir).isSymbolicLink();
    } catch {
      return false;
    }
  }

  #loadState() {
    if (this.#state) return this.#state;
    const base = defaultState();
    try {
      const raw = readFileSync(this.#statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        base.autoCheck = Boolean(parsed.autoCheck);
        base.lastCheckedAt = Number.isFinite(parsed.lastCheckedAt) && parsed.lastCheckedAt > 0 ? parsed.lastCheckedAt : 0;
        base.latestVersion = typeof parsed.latestVersion === 'string' && parseSemver(parsed.latestVersion) ? parsed.latestVersion : null;
        base.releaseUrl = isHttpUrl(parsed.releaseUrl) ? parsed.releaseUrl : null;
        base.releaseNotes = typeof parsed.releaseNotes === 'string' ? parsed.releaseNotes : '';
        base.source = typeof parsed.source === 'string' ? parsed.source : null;
        base.etag = typeof parsed.etag === 'string' ? parsed.etag : null;
        base.dismissedVersion = typeof parsed.dismissedVersion === 'string' && parseSemver(parsed.dismissedVersion) ? parsed.dismissedVersion : null;
        base.lastError = typeof parsed.lastError === 'string' ? parsed.lastError : null;
      }
    } catch {
      // Missing or malformed state file safely falls back to defaults.
    }
    this.#state = base;
    return this.#state;
  }

  #saveState(nextState) {
    this.#state = nextState;
    try {
      const dir = dirname(this.#statePath);
      mkdirSync(dir, { recursive: true });
      const json = `${JSON.stringify(nextState, null, 2)}\n`;
      const tmp = `${this.#statePath}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, json, 'utf8');
        renameSync(tmp, this.#statePath);
      } catch {
        writeFileSync(this.#statePath, json, 'utf8');
      }
    } catch {
      // Never fail sidecar requests if runtime state directory is read-only.
    }
  }

  getEnvPolicy() {
    const raw = String(this.#env?.TOKEN_METER_UPDATE_CHECK ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') return 'disabled';
    if (raw === '1' || raw === 'true' || raw === 'on') return 'enabled';
    return 'unset';
  }

  getUpdateCommand() {
    const owner = this.#repoInfo?.owner || 'AnTengye';
    const repo = this.#repoInfo?.repo || 'agy-token-meter';
    if (process.platform === 'win32') {
      return `irm https://raw.githubusercontent.com/${owner}/${repo}/main/install.ps1 | iex`;
    }
    return `curl -fsSL https://raw.githubusercontent.com/${owner}/${repo}/main/install.sh | bash`;
  }

  getStatus({ triggerBackgroundIfDue = false } = {}) {
    const state = this.#loadState();
    const envPolicy = this.getEnvPolicy();
    const effectiveAutoCheck = envPolicy === 'disabled' ? false : envPolicy === 'enabled' ? true : Boolean(state.autoCheck);

    if (triggerBackgroundIfDue && effectiveAutoCheck && envPolicy !== 'disabled' && !this.#inflight) {
      const nowTs = this.#now();
      const cacheExpired = !state.lastCheckedAt || nowTs - state.lastCheckedAt >= this.#ttlMs;
      const cooldownPassed = !this.#lastAttemptAt || nowTs - this.#lastAttemptAt >= this.#failureCooldownMs;
      if (cacheExpired && cooldownPassed) {
        void this.checkNow({ force: false, background: true });
      }
    }

    const cmp = state.latestVersion ? compareSemver(state.latestVersion, this.#currentVersion) : null;
    const hasUpdate = cmp === 1;
    const dismissed = Boolean(
      hasUpdate &&
        state.dismissedVersion &&
        compareSemver(state.dismissedVersion, state.latestVersion) === 0
    );

    return {
      currentVersion: this.#currentVersion,
      latestVersion: state.latestVersion,
      hasUpdate,
      dismissed,
      autoCheck: effectiveAutoCheck,
      envPolicy,
      disabledByEnv: envPolicy === 'disabled',
      checking: Boolean(this.#inflight),
      checkedAt: state.lastCheckedAt || null,
      source: state.source,
      releaseUrl: state.releaseUrl || this.#repoInfo?.htmlUrl || null,
      releaseNotes: state.releaseNotes || '',
      updateCommand: this.getUpdateCommand(),
      isSymlinkInstall: this.#isSymlinkInstall,
      lastError: state.lastError || null,
      repoUrl: this.#repoInfo?.htmlUrl || null,
    };
  }

  setAutoCheck(enabled) {
    const state = { ...this.#loadState(), autoCheck: Boolean(enabled) };
    this.#saveState(state);
    return this.getStatus();
  }

  dismissVersion(version) {
    const state = this.#loadState();
    const target = typeof version === 'string' && parseSemver(version) ? parseSemver(version).normalized : state.latestVersion;
    const next = { ...state, dismissedVersion: target || null };
    this.#saveState(next);
    return this.getStatus();
  }

  async checkNow({ force = false } = {}) {
    const envPolicy = this.getEnvPolicy();
    if (envPolicy === 'disabled') {
      return this.getStatus();
    }

    if (this.#inflight) {
      return this.#inflight;
    }

    const state = this.#loadState();
    const nowTs = this.#now();
    if (!force && state.lastCheckedAt && nowTs - state.lastCheckedAt < this.#ttlMs && state.latestVersion) {
      return this.getStatus();
    }

    this.#lastAttemptAt = nowTs;
    const run = this.#performCheck(state).finally(() => {
      if (this.#inflight === run) {
        this.#inflight = null;
      }
    });
    this.#inflight = run;
    return run;
  }

  async #fetchJson(url, headers = {}) {
    if (typeof this.#fetchImpl !== 'function') {
      throw new Error('fetch_unavailable');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    try {
      const res = await this.#fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': `agy-token-meter/${this.#currentVersion}`,
          ...headers,
        },
        signal: controller.signal,
      });
      if (res.status === 304) {
        return { notModified: true, status: 304, headers: res.headers };
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return { notModified: false, status: res.status, headers: res.headers, data };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error('request_timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  #parseReleaseOrManifestPayload(data, defaultUrl, defaultSource) {
    if (!data || typeof data !== 'object') {
      throw new Error('invalid_payload');
    }
    if (typeof data.tag_name === 'string') {
      const parsed = parseSemver(data.tag_name);
      if (!parsed) throw new Error('invalid_release_version');
      return {
        latestVersion: parsed.normalized,
        releaseUrl: isHttpUrl(data.html_url) ? data.html_url : defaultUrl,
        releaseNotes: summarizeNotes(data.body),
        source: defaultSource,
      };
    }
    if (typeof data.version === 'string') {
      const parsed = parseSemver(data.version);
      if (!parsed) throw new Error('invalid_manifest_version');
      return {
        latestVersion: parsed.normalized,
        releaseUrl: isHttpUrl(data.releaseUrl) ? data.releaseUrl : isHttpUrl(data.homepage) ? data.homepage : defaultUrl,
        releaseNotes: summarizeNotes(data.changelog || data.releaseNotes || ''),
        source: 'plugin-json',
      };
    }
    throw new Error('missing_version_field');
  }

  async #performCheck(prevState) {
    const nowTs = this.#now();
    const customUrl = String(this.#env?.TOKEN_METER_UPDATE_URL ?? '').trim();
    const customReleaseUrl = String(this.#env?.TOKEN_METER_RELEASE_API_URL ?? '').trim();
    const customManifestUrl = String(this.#env?.TOKEN_METER_RAW_MANIFEST_URL ?? '').trim();

    if (!customUrl && !this.#repoInfo && !customReleaseUrl && !customManifestUrl) {
      const next = { ...prevState, lastError: 'missing_repository_metadata' };
      this.#saveState(next);
      return this.getStatus();
    }

    const owner = this.#repoInfo?.owner || 'AnTengye';
    const repo = this.#repoInfo?.repo || 'agy-token-meter';
    const repoHtmlUrl = this.#repoInfo?.htmlUrl || `https://github.com/${owner}/${repo}`;

    try {
      if (customUrl) {
        if (!isHttpUrl(customUrl)) throw new Error('invalid_update_url');
        const headers = {};
        if (prevState.etag && prevState.source === 'custom-url') {
          headers['If-None-Match'] = prevState.etag;
        }
        const resp = await this.#fetchJson(customUrl, headers);
        if (resp.notModified) {
          this.#saveState({ ...prevState, lastCheckedAt: nowTs, lastError: null });
          return this.getStatus();
        }
        const parsed = this.#parseReleaseOrManifestPayload(resp.data, repoHtmlUrl, 'custom-url');
        const etag = resp.headers?.get?.('etag') || null;
        this.#saveState({
          ...prevState,
          ...parsed,
          etag,
          lastCheckedAt: nowTs,
          lastError: null,
        });
        return this.getStatus();
      }

      const releaseApiUrl = isHttpUrl(customReleaseUrl)
        ? customReleaseUrl
        : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
      const rawManifestUrl = isHttpUrl(customManifestUrl)
        ? customManifestUrl
        : `https://raw.githubusercontent.com/${owner}/${repo}/main/plugin.json`;

      try {
        const headers = { Accept: 'application/vnd.github+json' };
        if (prevState.etag && prevState.source === 'github-release') {
          headers['If-None-Match'] = prevState.etag;
        }
        const resp = await this.#fetchJson(releaseApiUrl, headers);
        if (resp.notModified) {
          this.#saveState({ ...prevState, lastCheckedAt: nowTs, lastError: null });
          return this.getStatus();
        }
        const parsed = this.#parseReleaseOrManifestPayload(resp.data, `${repoHtmlUrl}/releases`, 'github-release');
        const etag = resp.headers?.get?.('etag') || null;
        this.#saveState({
          ...prevState,
          ...parsed,
          etag,
          lastCheckedAt: nowTs,
          lastError: null,
        });
        return this.getStatus();
      } catch (err) {
        if (![403, 404, 429].includes(err?.status) && !(err?.status >= 500)) {
          throw err;
        }
        const resp = await this.#fetchJson(rawManifestUrl);
        const parsed = this.#parseReleaseOrManifestPayload(resp.data, `${repoHtmlUrl}/releases`, 'plugin-json');
        this.#saveState({
          ...prevState,
          ...parsed,
          etag: null,
          lastCheckedAt: nowTs,
          lastError: null,
        });
        return this.getStatus();
      }
    } catch (err) {
      this.#saveState({
        ...prevState,
        lastError: err?.message || 'update_check_failed',
      });
      return this.getStatus();
    }
  }
}
