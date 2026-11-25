import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_MODELS = new Map([
  [1530, 'gemini-4-hydrogen-tiered-high'],
  [1532, 'gemini-4-neon'],
  [1533, 'gemini-4-neon'],
  [1427, 'gemini-4-carbon'],
  [1669, 'gemini-flash-worker-agy'],
  [1667, 'gemini-pro-orchestrator'],
  [1537, 'gemini-pro-orchestrator-neon'],
  [1401, 'claude-opus-5-5-medium'],
  [1402, 'claude-opus-5-5-high'],
  [1403, 'claude-sonnet-5-5-low'],
]);

const DEFAULT_CONV_CACHE_LIMIT = 2000;
const RECENT_TURNS_LIMIT = 40;
const OVERVIEW_TTL_MS = 30_000;
const HOT_WINDOW_MS = 25 * 3600 * 1000;
const MAX_RETURNED_MEMBERS = 40;
const ACTIVE_WINDOW_SEC = 300;

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONV_CACHE_LIMIT = parsePositiveIntEnv('TOKEN_METER_CACHE_LIMIT', DEFAULT_CONV_CACHE_LIMIT);

export function getAppDataDir() {
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR,
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    join(homedir(), '.gemini', 'antigravity'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'conversations'))) return dir;
  }
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  const len = buf.length;
  while (i < len) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(result), i];
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error('Malformed varint');
    }
  }
  throw new Error('Truncated varint');
}

function skipField(buf, offset, wireType) {
  if (wireType === 0) {
    const [, next] = readVarint(buf, offset);
    return next;
  }
  if (wireType === 1) return offset + 8;
  if (wireType === 5) return offset + 4;
  if (wireType === 2) {
    const [len, start] = readVarint(buf, offset);
    return start + len;
  }
  throw new Error(`Unsupported wireType: ${wireType}`);
}

function parseTimestamp(buf, start, end) {
  let i = start;
  let sec = 0;
  let nanos = 0;
  while (i < end) {
    const [tag, next] = readVarint(buf, i);
    i = next;
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const [val, nextVal] = readVarint(buf, i);
      i = nextVal;
      if (fn === 1) sec = val;
      else if (fn === 2) nanos = val;
    } else {
      i = skipField(buf, i, wt);
    }
  }
  return sec > 0 ? sec + nanos / 1e9 : null;
}

function parseUsage(buf, start, end) {
  let i = start;
  let modelEnum = 0;
  let uncachedInput = 0;
  let output = 0;
  let cacheRead = 0;
  let provider = 0;
  let responseId = '';
  let thinking = 0;
  let visibleOutput = 0;

  while (i < end) {
    const [tag, next] = readVarint(buf, i);
    i = next;
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const [val, nextVal] = readVarint(buf, i);
      i = nextVal;
      if (fn === 1) modelEnum = val;
      else if (fn === 2) uncachedInput = val;
      else if (fn === 3) output = val;
      else if (fn === 5) cacheRead = val;
      else if (fn === 6) provider = val;
      else if (fn === 9) thinking = val;
      else if (fn === 10) visibleOutput = val;
    } else if (wt === 2) {
      const [len, sStart] = readVarint(buf, i);
      const sEnd = sStart + len;
      if (fn === 7 && sEnd <= end) {
        responseId = buf.toString('utf8', sStart, sEnd);
      }
      i = sEnd;
    } else {
      i = skipField(buf, i, wt);
    }
  }

  return {
    modelEnum,
    uncachedInput,
    output,
    cacheRead,
    provider,
    responseId,
    thinking,
    visibleOutput,
  };
}

function parseStepMetadata(buf) {
  let i = 0;
  const end = buf.length;
  let ts = null;
  let usage = null;

  while (i < end) {
    const [tag, next] = readVarint(buf, i);
    i = next;
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 2) {
      const [len, cStart] = readVarint(buf, i);
      const cEnd = Math.min(cStart + len, end);
      if (fn === 1) {
        ts = parseTimestamp(buf, cStart, cEnd);
      } else if (fn === 9) {
        usage = parseUsage(buf, cStart, cEnd);
      }
      i = cEnd;
      if (ts !== null && usage !== null) break;
    } else {
      i = skipField(buf, i, wt);
    }
  }
  return { ts, usage };
}

function tryExtractModelsFromGenMetadata(db, modelNames) {
  try {
    const rows = db.prepare('SELECT data FROM gen_metadata LIMIT 5').all();
    for (const row of rows) {
      if (!row?.data) continue;
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      let i = 0;
      const end = buf.length;
      let modelName = '';
      let cfgModelName = '';
      let modelEnum = 0;

      while (i < end) {
        const [tag, next] = readVarint(buf, i);
        i = next;
        const fn = tag >>> 3;
        const wt = tag & 7;
        if (wt === 2) {
          const [len, cStart] = readVarint(buf, i);
          const cEnd = Math.min(cStart + len, end);
          if (fn === 1) {
            let j = cStart;
            while (j < cEnd) {
              const [stag, snext] = readVarint(buf, j);
              j = snext;
              const sfn = stag >>> 3;
              const swt = stag & 7;
              if (swt === 2) {
                const [slen, scStart] = readVarint(buf, j);
                const scEnd = Math.min(scStart + slen, cEnd);
                if (sfn === 19) {
                  modelName = buf.toString('utf8', scStart, scEnd);
                } else if (sfn === 4) {
                  const u = parseUsage(buf, scStart, scEnd);
                  if (u.modelEnum) modelEnum = u.modelEnum;
                }
                j = scEnd;
              } else {
                j = skipField(buf, j, swt);
              }
            }
          } else if (fn === 3) {
            let j = cStart;
            while (j < cEnd) {
              const [stag, snext] = readVarint(buf, j);
              j = snext;
              const sfn = stag >>> 3;
              const swt = stag & 7;
              if (swt === 2) {
                const [slen, scStart] = readVarint(buf, j);
                const scEnd = Math.min(scStart + slen, cEnd);
                if (sfn === 28) {
                  cfgModelName = buf.toString('utf8', scStart, scEnd);
                }
                j = scEnd;
              } else {
                j = skipField(buf, j, swt);
              }
            }
          }
          i = cEnd;
        } else {
          i = skipField(buf, i, wt);
        }
      }
      const resolved = modelName || cfgModelName;
      if (modelEnum && resolved && !modelNames.has(modelEnum)) {
        modelNames.set(modelEnum, resolved);
      }
    }
  } catch {
    // Ignore gen_metadata errors; fallback to model enum label.
  }
}

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function getDbSignature(dbPath) {
  const dbStat = safeStat(dbPath);
  if (!dbStat) return null;
  const walStat = safeStat(`${dbPath}-wal`);
  const walMtime = walStat ? walStat.mtimeMs : 0;
  const walSize = walStat ? walStat.size : 0;
  return {
    sig: `${dbStat.mtimeMs}:${dbStat.size}:${walMtime}:${walSize}`,
    dbSize: dbStat.size,
    walSize,
    latestMtimeMs: Math.max(dbStat.mtimeMs, walMtime),
  };
}

function createEmptyAccum() {
  return {
    lastIdx: -1,
    calls: 0,
    compactions: 0,
    uncachedInput: 0,
    cacheRead: 0,
    totalInput: 0,
    output: 0,
    thinking: 0,
    visibleOutput: 0,
    totalTokens: 0,
    firstTs: null,
    lastTs: null,
    models: new Map(),
    lastTurn: null,
    recentTurns: [],
  };
}

function addStepToAccum(accum, idx, stepType, ts, usage, modelNames) {
  const totalIn = usage.uncachedInput + usage.cacheRead;
  const totalTok = totalIn + usage.output;
  accum.calls += 1;
  if (stepType === 23) accum.compactions += 1;
  accum.uncachedInput += usage.uncachedInput;
  accum.cacheRead += usage.cacheRead;
  accum.totalInput += totalIn;
  accum.output += usage.output;
  accum.thinking += usage.thinking;
  accum.visibleOutput += usage.visibleOutput;
  accum.totalTokens += totalTok;

  if (ts !== null) {
    if (accum.firstTs === null || ts < accum.firstTs) accum.firstTs = ts;
    if (accum.lastTs === null || ts > accum.lastTs) accum.lastTs = ts;
  }

  const mEnum = usage.modelEnum || 0;
  const modelName = modelNames.get(mEnum) || (mEnum ? `model-${mEnum}` : 'unknown');
  let mStat = accum.models.get(modelName);
  if (!mStat) {
    mStat = {
      model: modelName,
      calls: 0,
      uncachedInput: 0,
      cacheRead: 0,
      totalInput: 0,
      output: 0,
      thinking: 0,
      visibleOutput: 0,
      totalTokens: 0,
    };
    accum.models.set(modelName, mStat);
  }
  mStat.calls += 1;
  mStat.uncachedInput += usage.uncachedInput;
  mStat.cacheRead += usage.cacheRead;
  mStat.totalInput += totalIn;
  mStat.output += usage.output;
  mStat.thinking += usage.thinking;
  mStat.visibleOutput += usage.visibleOutput;
  mStat.totalTokens += totalTok;

  const turn = {
    idx,
    ts,
    stepType,
    isCompaction: stepType === 23,
    model: modelName,
    uncachedInput: usage.uncachedInput,
    cacheRead: usage.cacheRead,
    totalInput: totalIn,
    output: usage.output,
    thinking: usage.thinking,
    visibleOutput: usage.visibleOutput,
    totalTokens: totalTok,
    hitRate: totalIn > 0 ? Number(((usage.cacheRead / totalIn) * 100).toFixed(2)) : 0,
  };
  accum.lastTurn = turn;
  accum.recentTurns.push(turn);
  if (accum.recentTurns.length > RECENT_TURNS_LIMIT) {
    accum.recentTurns.shift();
  }
}

function finalizeStats(accum, sig, latestMtimeMs) {
  const hitRate = accum.totalInput > 0 ? Number(((accum.cacheRead / accum.totalInput) * 100).toFixed(2)) : 0;
  const models = {};
  for (const [name, m] of accum.models.entries()) {
    models[name] = {
      ...m,
      hitRate: m.totalInput > 0 ? Number(((m.cacheRead / m.totalInput) * 100).toFixed(2)) : 0,
    };
  }
  return {
    sig,
    latestMtimeMs,
    lastIdx: accum.lastIdx,
    calls: accum.calls,
    compactions: accum.compactions,
    uncachedInput: accum.uncachedInput,
    cacheRead: accum.cacheRead,
    totalInput: accum.totalInput,
    output: accum.output,
    thinking: accum.thinking,
    visibleOutput: accum.visibleOutput,
    totalTokens: accum.totalTokens,
    hitRate,
    firstTs: accum.firstTs,
    lastTs: accum.lastTs,
    models,
    lastTurn: accum.lastTurn,
    recentTurns: accum.recentTurns,
  };
}

function readStepsIntoAccum(dbPath, accum, startAfterIdx, modelNames) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    const stmt = db.prepare(
      'SELECT idx, step_type, metadata FROM steps WHERE idx > ? AND metadata IS NOT NULL ORDER BY idx ASC'
    );
    const rows = stmt.all(startAfterIdx);
    let needResolveModel = false;
    const parsedRows = [];

    for (const row of rows) {
      if (row.idx > accum.lastIdx) accum.lastIdx = row.idx;
      if (!row.metadata) continue;
      const buf = Buffer.isBuffer(row.metadata) ? row.metadata : Buffer.from(row.metadata);
      const { ts, usage } = parseStepMetadata(buf);
      if (usage) {
        if (usage.modelEnum && !modelNames.has(usage.modelEnum)) {
          needResolveModel = true;
        }
        parsedRows.push({ idx: row.idx, stepType: row.step_type, ts, usage });
      }
    }

    if (needResolveModel) {
      tryExtractModelsFromGenMetadata(db, modelNames);
    }

    for (const r of parsedRows) {
      addStepToAccum(accum, r.idx, r.stepType, r.ts, r.usage, modelNames);
    }
  } catch {
    // Missing steps table or transient uninitialized DB returns current accum safely.
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close failure
      }
    }
  }
}

export class TokenMeterEngine {
  #appDataDir;
  #convDir;
  #brainDir;
  #summaryDbPath;
  #modelNames;
  #convCacheLimit;
  #convCache = new Map(); // cid -> { sig, dbSize, accum, snapshot }
  #summaryCache = { sig: null, metaMap: new Map(), childrenMap: new Map() };
  #swarmCache = new Map(); // rootId -> { mtimeMs, data }
  #overviewCache = new Map(); // range -> { ts, data }
  #convDirScan = {
    initialized: false,
    dirMtimeMs: -1,
    dbMtimeIndex: new Map(),
    walSet: new Set(),
    unindexedSet: new Set(),
    hotSet: new Set(),
  };
  #lastOverviewScanStats = {
    dirChanged: false,
    readdirCalls: 0,
    statCalls: 0,
    totalIndexed: 0,
    hotSetSize: 0,
    candidateCount: 0,
  };

  constructor(appDataDir = getAppDataDir()) {
    this.#appDataDir = appDataDir;
    this.#convDir = join(appDataDir, 'conversations');
    this.#brainDir = join(appDataDir, 'brain');
    this.#summaryDbPath = join(appDataDir, 'conversation_summaries.db');
    this.#modelNames = new Map(KNOWN_MODELS);
    this.#convCacheLimit = parsePositiveIntEnv('TOKEN_METER_CACHE_LIMIT', DEFAULT_CONV_CACHE_LIMIT);
  }

  get cacheLimit() {
    return this.#convCacheLimit;
  }

  getOverviewScanStats() {
    return {
      ...this.#lastOverviewScanStats,
      totalIndexed: this.#convDirScan.dbMtimeIndex.size,
      hotSetSize: this.#convDirScan.hotSet.size,
    };
  }

  #touchConvCache(cid, entry) {
    if (this.#convCache.has(cid)) {
      this.#convCache.delete(cid);
    } else if (this.#convCache.size >= this.#convCacheLimit) {
      const oldest = this.#convCache.keys().next().value;
      if (oldest !== undefined) this.#convCache.delete(oldest);
    }
    this.#convCache.set(cid, entry);
  }

  readConversationStats(cid) {
    if (!cid || !UUID_RE.test(cid)) return null;
    const dbPath = join(this.#convDir, `${cid}.db`);
    const sigInfo = getDbSignature(dbPath);
    if (!sigInfo) {
      this.#convCache.delete(cid);
      this.#convDirScan.dbMtimeIndex.delete(cid);
      this.#convDirScan.hotSet.delete(cid);
      this.#convDirScan.unindexedSet.delete(cid);
      return null;
    }

    this.#convDirScan.dbMtimeIndex.set(cid, sigInfo.latestMtimeMs);
    if (sigInfo.walSize > 0 || sigInfo.latestMtimeMs >= Date.now() - HOT_WINDOW_MS) {
      this.#convDirScan.hotSet.add(cid);
    } else {
      this.#convDirScan.hotSet.delete(cid);
    }

    const cached = this.#convCache.get(cid);
    if (cached && cached.sig === sigInfo.sig) {
      this.#touchConvCache(cid, cached);
      return cached.snapshot;
    }

    let accum;
    let startAfter = -1;
    if (cached && !(sigInfo.dbSize < cached.dbSize && sigInfo.walSize === 0)) {
      accum = cached.accum;
      startAfter = accum.lastIdx;
    } else {
      accum = createEmptyAccum();
    }

    readStepsIntoAccum(dbPath, accum, startAfter, this.#modelNames);
    const snapshot = finalizeStats(accum, sigInfo.sig, sigInfo.latestMtimeMs);
    this.#touchConvCache(cid, {
      sig: sigInfo.sig,
      dbSize: sigInfo.dbSize,
      accum,
      snapshot,
    });
    return snapshot;
  }

  readConversationWindowStats(cid, startSec, endSec) {
    const full = this.readConversationStats(cid);
    if (!full || full.calls === 0) return null;
    if (full.lastTs !== null && full.lastTs < startSec) return null;
    if (full.firstTs !== null && full.firstTs >= startSec && (full.lastTs === null || full.lastTs <= endSec)) {
      return full;
    }

    const dbPath = join(this.#convDir, `${cid}.db`);
    const accum = createEmptyAccum();
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
      const rows = db.prepare('SELECT idx, step_type, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC').all();
      for (const row of rows) {
        if (!row.metadata) continue;
        const buf = Buffer.isBuffer(row.metadata) ? row.metadata : Buffer.from(row.metadata);
        const { ts, usage } = parseStepMetadata(buf);
        if (!usage || ts === null) continue;
        if (ts >= startSec && ts <= endSec) {
          if (usage.modelEnum && !this.#modelNames.has(usage.modelEnum)) {
            tryExtractModelsFromGenMetadata(db, this.#modelNames);
          }
          addStepToAccum(accum, row.idx, row.step_type, ts, usage, this.#modelNames);
        }
      }
    } catch {
      return null;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
    if (accum.calls === 0) return null;
    return finalizeStats(accum, full.sig, full.latestMtimeMs);
  }

  #ensureSummaryIndex() {
    const sigInfo = getDbSignature(this.#summaryDbPath);
    if (!sigInfo) return this.#summaryCache;
    if (this.#summaryCache.sig === sigInfo.sig) return this.#summaryCache;

    const metaMap = new Map();
    const childrenMap = new Map();
    let db;
    try {
      db = new DatabaseSync(this.#summaryDbPath, { readOnly: true, timeout: 1000 });
      const rows = db
        .prepare(
          'SELECT conversation_id, title, parent_conversation_id, nesting_depth, agent_name, step_count, last_modified_time FROM conversation_summaries'
        )
        .all();
      for (const r of rows) {
        const cid = r.conversation_id;
        if (!cid) continue;
        metaMap.set(cid, {
          cid,
          title: r.title || '',
          parent: r.parent_conversation_id || '',
          depth: Number(r.nesting_depth) || 0,
          agent: r.agent_name || '',
          stepCount: Number(r.step_count) || 0,
          lastModifiedTime: r.last_modified_time || '',
        });
      }
      try {
        const prows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all();
        for (const p of prows) {
          if (!p.conversation_id || !p.parent_id) continue;
          const cur = metaMap.get(p.conversation_id);
          if (cur) {
            if (!cur.parent) cur.parent = p.parent_id;
          } else {
            metaMap.set(p.conversation_id, {
              cid: p.conversation_id,
              title: '',
              parent: p.parent_id,
              depth: 1,
              agent: '',
              stepCount: 0,
              lastModifiedTime: '',
            });
          }
        }
      } catch {
        // conversation_parents optional
      }

      for (const [cid, info] of metaMap.entries()) {
        if (!info.parent) continue;
        let set = childrenMap.get(info.parent);
        if (!set) {
          set = new Set();
          childrenMap.set(info.parent, set);
        }
        set.add(cid);
      }

      this.#summaryCache = { sig: sigInfo.sig, metaMap, childrenMap };
    } catch {
      // Keep stale cache if summary DB is temporarily unreadable.
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
    return this.#summaryCache;
  }

  #readSwarmMembers(rootId) {
    const membersPath = join(this.#brainDir, rootId, '.system_generated', 'swarm', 'members.json');
    const st = safeStat(membersPath);
    if (!st) {
      this.#swarmCache.delete(rootId);
      return null;
    }
    const cached = this.#swarmCache.get(rootId);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }
    try {
      const parsed = JSON.parse(readFileSync(membersPath, 'utf8'));
      const byCid = new Map();
      if (parsed && parsed.members && typeof parsed.members === 'object') {
        for (const [name, m] of Object.entries(parsed.members)) {
          if (!m?.conversation_id) continue;
          byCid.set(m.conversation_id, {
            name,
            role: m.role || 'worker',
            phase: m.phase || '',
            killed: Boolean(m.killed),
            model: m.applied_model || m.desired_model || m.model || '',
          });
        }
      }
      const data = { title: parsed?.title || '', byCid };
      this.#swarmCache.set(rootId, { mtimeMs: st.mtimeMs, size: st.size, data });
      return data;
    } catch {
      return null;
    }
  }

  #readLocalSwarmAnchor(cid) {
    const anchorPath = join(this.#brainDir, cid, '.system_generated', 'swarm', 'swarm.json');
    if (!existsSync(anchorPath)) return '';
    try {
      const data = JSON.parse(readFileSync(anchorPath, 'utf8'));
      return data?.coordinator_conversation_id || data?.swarm_id || '';
    } catch {
      return '';
    }
  }

  #findRootId(cid, metaMap) {
    let cur = cid;
    const seen = new Set([cur]);
    while (true) {
      const parent = metaMap.get(cur)?.parent || this.#readLocalSwarmAnchor(cur) || '';
      if (!parent || seen.has(parent) || parent === cur) return cur;
      seen.add(parent);
      cur = parent;
    }
  }

  #collectFamilyTree(rootId, metaMap, childrenMap, swarmInfo) {
    const depthMap = new Map([[rootId, 0]]);
    const queue = [rootId];
    let head = 0;

    while (head < queue.length) {
      const cur = queue[head++];
      const curDepth = depthMap.get(cur) ?? 0;
      const children = childrenMap.get(cur);
      if (children) {
        for (const child of children) {
          if (!depthMap.has(child)) {
            depthMap.set(child, curDepth + 1);
            queue.push(child);
          }
        }
      }
    }

    if (swarmInfo?.byCid) {
      for (const mcid of swarmInfo.byCid.keys()) {
        if (!depthMap.has(mcid)) {
          depthMap.set(mcid, mcid === rootId ? 0 : 1);
        }
      }
    }
    return depthMap;
  }

  getSessionSnapshot(cid, clientEtag = '') {
    if (!cid || !UUID_RE.test(cid)) {
      return {
        conversationId: cid || null,
        exists: false,
        mode: 'empty',
        error: cid ? 'invalid_conversation_id' : 'missing_conversation_id',
      };
    }

    const { metaMap, childrenMap } = this.#ensureSummaryIndex();
    const rootId = this.#findRootId(cid, metaMap);
    const swarmInfo = this.#readSwarmMembers(rootId);
    const depthMap = this.#collectFamilyTree(rootId, metaMap, childrenMap, swarmInfo);
    if (!depthMap.has(cid)) depthMap.set(cid, cid === rootId ? 0 : 1);

    const memberIds = [...depthMap.keys()];
    const hasher = createHash('sha1');
    hasher.update(`${cid}|${rootId}|${swarmInfo ? 'swarm' : 'tree'}|`);

    const memberStats = [];
    for (const mcid of memberIds) {
      const stats = this.readConversationStats(mcid);
      hasher.update(`${mcid}:${stats ? stats.sig : '0'};`);
      memberStats.push({ mcid, stats, depth: depthMap.get(mcid) ?? 0 });
    }

    const etag = hasher.digest('hex').slice(0, 16);
    if (clientEtag && clientEtag === etag) {
      return { conversationId: cid, unchanged: true, etag };
    }

    const selfEntry = memberStats.find((x) => x.mcid === cid);
    const selfStats = selfEntry?.stats || null;
    const selfMeta = metaMap.get(cid) || {};
    const rootMeta = metaMap.get(rootId) || {};

    // Determine orchestration mode
    let maxDepth = 0;
    let hasTeamworkAgent = false;
    for (const { mcid, depth } of memberStats) {
      if (depth > maxDepth) maxDepth = depth;
      const ag = (metaMap.get(mcid)?.agent || '').toLowerCase();
      if (ag.startsWith('teamwork')) hasTeamworkAgent = true;
    }
    let mode = 'single';
    if (swarmInfo) mode = 'swarm';
    else if (memberIds.length > 1 && (hasTeamworkAgent || maxDepth >= 2)) mode = 'teamwork';
    else if (memberIds.length > 1) mode = 'subagents';

    // Aggregate family totals + byModel + byDepth
    const nowSec = Date.now() / 1000;
    const famModels = new Map();
    const famDepths = new Map();
    let famCalls = 0;
    let famCompactions = 0;
    let famUncached = 0;
    let famCacheRead = 0;
    let famTotalIn = 0;
    let famOutput = 0;
    let famThinking = 0;
    let famVisible = 0;
    let famTotalTokens = 0;
    let activeMembers = 0;
    let membersWithUsage = 0;

    const allMembers = [];
    for (const { mcid, stats, depth } of memberStats) {
      const meta = metaMap.get(mcid) || {};
      const sw = swarmInfo?.byCid.get(mcid) || null;
      const isActive =
        (stats?.lastTs && nowSec - stats.lastTs <= ACTIVE_WINDOW_SEC) ||
        (sw && !sw.killed && sw.phase && sw.phase !== 'KILLED');
      if (isActive) activeMembers += 1;

      if (stats && stats.calls > 0) {
        membersWithUsage += 1;
        famCalls += stats.calls;
        famCompactions += stats.compactions;
        famUncached += stats.uncachedInput;
        famCacheRead += stats.cacheRead;
        famTotalIn += stats.totalInput;
        famOutput += stats.output;
        famThinking += stats.thinking;
        famVisible += stats.visibleOutput;
        famTotalTokens += stats.totalTokens;

        for (const [mName, m] of Object.entries(stats.models)) {
          let fm = famModels.get(mName);
          if (!fm) {
            fm = {
              model: mName,
              calls: 0,
              uncachedInput: 0,
              cacheRead: 0,
              totalInput: 0,
              output: 0,
              thinking: 0,
              visibleOutput: 0,
              totalTokens: 0,
            };
            famModels.set(mName, fm);
          }
          fm.calls += m.calls;
          fm.uncachedInput += m.uncachedInput;
          fm.cacheRead += m.cacheRead;
          fm.totalInput += m.totalInput;
          fm.output += m.output;
          fm.thinking += m.thinking;
          fm.visibleOutput += m.visibleOutput;
          fm.totalTokens += m.totalTokens;
        }

        let fd = famDepths.get(depth);
        if (!fd) {
          fd = { depth, sessions: 0, calls: 0, totalInput: 0, cacheRead: 0, output: 0, totalTokens: 0 };
          famDepths.set(depth, fd);
        }
        fd.sessions += 1;
        fd.calls += stats.calls;
        fd.totalInput += stats.totalInput;
        fd.cacheRead += stats.cacheRead;
        fd.output += stats.output;
        fd.totalTokens += stats.totalTokens;
      }

      const topModel = stats
        ? Object.values(stats.models).sort((a, b) => b.calls - a.calls)[0]?.model || ''
        : sw?.model || '';

      allMembers.push({
        cid: mcid,
        isCurrent: mcid === cid,
        isRoot: mcid === rootId,
        isActive: Boolean(isActive),
        depth,
        agent: sw?.name || meta.agent || (mcid === rootId ? 'coordinator' : 'worker'),
        role: sw?.role || (mcid === rootId ? 'root' : meta.agent || 'subagent'),
        phase: sw?.phase || (sw?.killed ? 'KILLED' : ''),
        title: meta.title || '',
        model: topModel,
        calls: stats?.calls || 0,
        compactions: stats?.compactions || 0,
        uncachedInput: stats?.uncachedInput || 0,
        cacheRead: stats?.cacheRead || 0,
        totalInput: stats?.totalInput || 0,
        output: stats?.output || 0,
        thinking: stats?.thinking || 0,
        totalTokens: stats?.totalTokens || 0,
        hitRate: stats?.hitRate || 0,
        lastTs: stats?.lastTs || null,
      });
    }

    // Prioritize current, root, active members, then highest token usage
    allMembers.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.totalTokens - a.totalTokens;
    });

    const returnedMembers = allMembers.slice(0, MAX_RETURNED_MEMBERS);
    const omittedCount = Math.max(0, allMembers.length - returnedMembers.length);

    const familyByModel = [...famModels.values()]
      .map((m) => ({
        ...m,
        hitRate: m.totalInput > 0 ? Number(((m.cacheRead / m.totalInput) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const depthSummary = [...famDepths.values()]
      .sort((a, b) => a.depth - b.depth)
      .map((d) => ({
        ...d,
        hitRate: d.totalInput > 0 ? Number(((d.cacheRead / d.totalInput) * 100).toFixed(2)) : 0,
      }));

    const selfModelList = selfStats
      ? Object.values(selfStats.models).sort((a, b) => b.totalTokens - a.totalTokens)
      : [];

    return {
      conversationId: cid,
      rootId,
      etag,
      exists: Boolean(selfStats),
      mode,
      title: selfMeta.title || rootMeta.title || swarmInfo?.title || '',
      rootTitle: rootMeta.title || swarmInfo?.title || '',
      agent: swarmInfo?.byCid.get(cid)?.name || selfMeta.agent || (cid === rootId ? 'root' : 'subagent'),
      self: selfStats
        ? {
            calls: selfStats.calls,
            compactions: selfStats.compactions,
            uncachedInput: selfStats.uncachedInput,
            cacheRead: selfStats.cacheRead,
            totalInput: selfStats.totalInput,
            output: selfStats.output,
            thinking: selfStats.thinking,
            visibleOutput: selfStats.visibleOutput,
            totalTokens: selfStats.totalTokens,
            hitRate: selfStats.hitRate,
            firstTs: selfStats.firstTs,
            lastTs: selfStats.lastTs,
            primaryModel: selfStats.lastTurn?.model || selfModelList[0]?.model || '',
            models: selfModelList,
            lastTurn: selfStats.lastTurn,
            recentTurns: selfStats.recentTurns.slice(-30),
          }
        : {
            calls: 0,
            compactions: 0,
            uncachedInput: 0,
            cacheRead: 0,
            totalInput: 0,
            output: 0,
            thinking: 0,
            visibleOutput: 0,
            totalTokens: 0,
            hitRate: 0,
            firstTs: null,
            lastTs: null,
            primaryModel: '',
            models: [],
            lastTurn: null,
            recentTurns: [],
          },
      family: {
        totalMembers: memberIds.length,
        membersWithUsage,
        activeMembers,
        calls: famCalls,
        compactions: famCompactions,
        uncachedInput: famUncached,
        cacheRead: famCacheRead,
        totalInput: famTotalIn,
        output: famOutput,
        thinking: famThinking,
        visibleOutput: famVisible,
        totalTokens: famTotalTokens,
        hitRate: famTotalIn > 0 ? Number(((famCacheRead / famTotalIn) * 100).toFixed(2)) : 0,
        byModel: familyByModel,
        depthSummary,
      },
      members: returnedMembers,
      totalMemberCount: allMembers.length,
      omittedCount,
      updatedAt: Date.now(),
    };
  }

  #statConvFiles(cid, checkWal = true) {
    const dbPath = join(this.#convDir, `${cid}.db`);
    const dbStat = safeStat(dbPath);
    if (!dbStat) return null;
    const walStat = checkWal ? safeStat(`${dbPath}-wal`) : null;
    return {
      mtimeMs: Math.max(dbStat.mtimeMs, walStat ? walStat.mtimeMs : 0),
      walSize: walStat ? walStat.size : 0,
      hasWal: Boolean(walStat),
    };
  }

  #collectOverviewCandidates(startMs, nowMs, metaMap) {
    const windowCutoffMs = startMs - 60_000;
    const hotCutoffMs = nowMs - HOT_WINDOW_MS;
    const candidates = new Set();

    // 1. Pre-filter candidates from conversation_summaries.db first
    for (const [cid, info] of metaMap.entries()) {
      if (!info.lastModifiedTime) continue;
      const ms = Date.parse(info.lastModifiedTime);
      if (!Number.isNaN(ms) && ms >= windowCutoffMs) {
        candidates.add(cid);
      }
    }

    // 2. Directory mtime fast path for conversations/ fallback scan
    const scan = this.#convDirScan;
    let dirChanged = false;
    let readdirCalls = 0;
    let statCalls = 0;

    try {
      const dirStat = safeStat(this.#convDir);
      if (dirStat) {
        dirChanged = !scan.initialized || dirStat.mtimeMs !== scan.dirMtimeMs;
        if (dirChanged) {
          readdirCalls += 1;
          const files = readdirSync(this.#convDir);
          const seenCids = new Set();
          const nextWalSet = new Set();
          const newOrWalAppeared = new Set();

          for (const f of files) {
            if (f.endsWith('.db')) {
              const cid = f.slice(0, -3);
              if (UUID_RE.test(cid)) {
                seenCids.add(cid);
                if (!scan.dbMtimeIndex.has(cid)) newOrWalAppeared.add(cid);
              }
            } else if (f.endsWith('.db-wal')) {
              const cid = f.slice(0, -7);
              if (UUID_RE.test(cid)) {
                seenCids.add(cid);
                nextWalSet.add(cid);
                if (!scan.walSet.has(cid) || !scan.dbMtimeIndex.has(cid)) {
                  newOrWalAppeared.add(cid);
                }
              }
            }
          }

          for (const oldCid of scan.dbMtimeIndex.keys()) {
            if (!seenCids.has(oldCid)) {
              scan.dbMtimeIndex.delete(oldCid);
              scan.hotSet.delete(oldCid);
            }
          }

          const nextUnindexed = new Set();
          for (const cid of seenCids) {
            const meta = metaMap.get(cid);
            if (!meta || !meta.lastModifiedTime) {
              nextUnindexed.add(cid);
            }
          }

          // First scan stats all non-summary DBs once to build dbMtimeIndex;
          // subsequent dir-changed scans only stat newly appeared / unindexed / hot entries.
          const toStat = new Set();
          if (!scan.initialized) {
            for (const cid of seenCids) {
              if (!candidates.has(cid)) toStat.add(cid);
            }
          } else {
            for (const cid of newOrWalAppeared) toStat.add(cid);
            for (const cid of nextUnindexed) toStat.add(cid);
            for (const cid of scan.hotSet) {
              if (seenCids.has(cid)) toStat.add(cid);
            }
          }

          for (const cid of toStat) {
            if (candidates.has(cid)) continue;
            const hasWal = nextWalSet.has(cid);
            statCalls += hasWal ? 2 : 1;
            const st = this.#statConvFiles(cid, hasWal);
            if (st) {
              scan.dbMtimeIndex.set(cid, st.mtimeMs);
              if (st.mtimeMs >= windowCutoffMs) {
                candidates.add(cid);
              }
              if (st.mtimeMs >= hotCutoffMs || st.walSize > 0) {
                scan.hotSet.add(cid);
              } else {
                scan.hotSet.delete(cid);
              }
            }
          }

          for (const [cid, mt] of scan.dbMtimeIndex.entries()) {
            if (mt >= windowCutoffMs) {
              candidates.add(cid);
            }
          }

          scan.initialized = true;
          scan.dirMtimeMs = dirStat.mtimeMs;
          scan.walSet = nextWalSet;
          scan.unindexedSet = nextUnindexed;
        } else {
          // Fast path: dirMtimeMs unchanged -> skip readdirSync; only check hot/unindexed/window entries
          const toCheck = new Set();
          for (const cid of [...scan.unindexedSet]) {
            const meta = metaMap.get(cid);
            if (meta && meta.lastModifiedTime) {
              scan.unindexedSet.delete(cid);
            } else {
              toCheck.add(cid);
            }
          }
          for (const cid of scan.hotSet) toCheck.add(cid);
          for (const [cid, mt] of scan.dbMtimeIndex.entries()) {
            if (mt >= windowCutoffMs) toCheck.add(cid);
          }

          for (const cid of toCheck) {
            if (candidates.has(cid)) continue;
            statCalls += 2;
            const st = this.#statConvFiles(cid, true);
            if (st) {
              scan.dbMtimeIndex.set(cid, st.mtimeMs);
              if (st.hasWal) scan.walSet.add(cid);
              if (st.mtimeMs >= windowCutoffMs) {
                candidates.add(cid);
              }
              if (st.mtimeMs >= hotCutoffMs || st.walSize > 0) {
                scan.hotSet.add(cid);
              } else {
                scan.hotSet.delete(cid);
              }
            } else {
              scan.dbMtimeIndex.delete(cid);
              scan.hotSet.delete(cid);
              scan.unindexedSet.delete(cid);
            }
          }
        }
      }
    } catch {
      // ignore readdir/stat failure
    }

    this.#lastOverviewScanStats = {
      dirChanged,
      readdirCalls,
      statCalls,
      totalIndexed: scan.dbMtimeIndex.size,
      hotSetSize: scan.hotSet.size,
      candidateCount: candidates.size,
    };

    return candidates;
  }

  getOverview(range = 'today', force = false) {
    const normRange = range === '24h' ? '24h' : 'today';
    const nowMs = Date.now();
    const cached = this.#overviewCache.get(normRange);
    if (!force && cached && nowMs - cached.ts < OVERVIEW_TTL_MS) {
      return { ...cached.data, cached: true };
    }

    const t0 = performance.now();
    const endSec = nowMs / 1000;
    let startMs;
    if (normRange === '24h') {
      startMs = nowMs - 24 * 3600 * 1000;
    } else {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      startMs = d.getTime();
    }
    const startSec = startMs / 1000;

    const { metaMap } = this.#ensureSummaryIndex();
    const candidates = this.#collectOverviewCandidates(startMs, nowMs, metaMap);

    const rootGroups = new Map();
    const byModelMap = new Map();
    let totalSessions = 0;
    let totalCalls = 0;
    let totalCompactions = 0;
    let totalUncached = 0;
    let totalCacheRead = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalThinking = 0;
    let totalVisible = 0;
    let totalTokens = 0;

    for (const cid of candidates) {
      const wstats = this.readConversationWindowStats(cid, startSec, endSec);
      if (!wstats || wstats.calls === 0) continue;

      totalSessions += 1;
      totalCalls += wstats.calls;
      totalCompactions += wstats.compactions;
      totalUncached += wstats.uncachedInput;
      totalCacheRead += wstats.cacheRead;
      totalInput += wstats.totalInput;
      totalOutput += wstats.output;
      totalThinking += wstats.thinking;
      totalVisible += wstats.visibleOutput;
      totalTokens += wstats.totalTokens;

      for (const [mName, m] of Object.entries(wstats.models)) {
        let gm = byModelMap.get(mName);
        if (!gm) {
          gm = {
            model: mName,
            calls: 0,
            uncachedInput: 0,
            cacheRead: 0,
            totalInput: 0,
            output: 0,
            thinking: 0,
            totalTokens: 0,
          };
          byModelMap.set(mName, gm);
        }
        gm.calls += m.calls;
        gm.uncachedInput += m.uncachedInput;
        gm.cacheRead += m.cacheRead;
        gm.totalInput += m.totalInput;
        gm.output += m.output;
        gm.thinking += m.thinking;
        gm.totalTokens += m.totalTokens;
      }

      const rootId = this.#findRootId(cid, metaMap);
      let g = rootGroups.get(rootId);
      if (!g) {
        const rootMeta = metaMap.get(rootId) || {};
        const hasSwarm = existsSync(join(this.#brainDir, rootId, '.system_generated', 'swarm', 'members.json'));
        g = {
          rootId,
          title: rootMeta.title || metaMap.get(cid)?.title || rootId.slice(0, 8),
          mode: hasSwarm ? 'swarm' : 'single',
          sessionCount: 0,
          calls: 0,
          uncachedInput: 0,
          cacheRead: 0,
          totalInput: 0,
          output: 0,
          totalTokens: 0,
          lastTs: 0,
          models: new Set(),
        };
        rootGroups.set(rootId, g);
      }
      g.sessionCount += 1;
      g.calls += wstats.calls;
      g.uncachedInput += wstats.uncachedInput;
      g.cacheRead += wstats.cacheRead;
      g.totalInput += wstats.totalInput;
      g.output += wstats.output;
      g.totalTokens += wstats.totalTokens;
      if (wstats.lastTs && wstats.lastTs > g.lastTs) g.lastTs = wstats.lastTs;
      if (g.sessionCount > 1 && g.mode === 'single') g.mode = 'teamwork';
      for (const mName of Object.keys(wstats.models)) g.models.add(mName);
    }

    const roots = [...rootGroups.values()]
      .map((g) => ({
        rootId: g.rootId,
        title: g.title,
        mode: g.mode,
        sessionCount: g.sessionCount,
        calls: g.calls,
        uncachedInput: g.uncachedInput,
        cacheRead: g.cacheRead,
        totalInput: g.totalInput,
        output: g.output,
        totalTokens: g.totalTokens,
        hitRate: g.totalInput > 0 ? Number(((g.cacheRead / g.totalInput) * 100).toFixed(2)) : 0,
        lastTs: g.lastTs,
        models: [...g.models],
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 50);

    const byModel = [...byModelMap.values()]
      .map((m) => ({
        ...m,
        hitRate: m.totalInput > 0 ? Number(((m.cacheRead / m.totalInput) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const computedMs = Number((performance.now() - t0).toFixed(2));
    const data = {
      range: normRange,
      startMs,
      endMs: nowMs,
      totals: {
        sessions: totalSessions,
        roots: rootGroups.size,
        calls: totalCalls,
        compactions: totalCompactions,
        uncachedInput: totalUncached,
        cacheRead: totalCacheRead,
        totalInput,
        output: totalOutput,
        thinking: totalThinking,
        visibleOutput: totalVisible,
        totalTokens,
        hitRate: totalInput > 0 ? Number(((totalCacheRead / totalInput) * 100).toFixed(2)) : 0,
      },
      byModel,
      roots,
      computedMs,
      generatedAt: nowMs,
      cached: false,
    };

    this.#overviewCache.set(normRange, { ts: nowMs, data });
    return data;
  }
}
