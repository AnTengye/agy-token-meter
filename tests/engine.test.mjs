import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { CONV_CACHE_LIMIT, TokenMeterEngine } from '../sidecars/meter/engine.mjs';

function encodeVarint(value) {
  let v = BigInt(value);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function encodeFieldVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function encodeFieldBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

function buildStepMetadata({ tsSec, modelEnum = 1532, uncachedInput = 100, output = 50, cacheRead = 900 }) {
  const tsBuf = encodeFieldVarint(1, Math.floor(tsSec));
  const usageBuf = Buffer.concat([
    encodeFieldVarint(1, modelEnum),
    encodeFieldVarint(2, uncachedInput),
    encodeFieldVarint(3, output),
    encodeFieldVarint(5, cacheRead),
  ]);
  return Buffer.concat([encodeFieldBytes(1, tsBuf), encodeFieldBytes(9, usageBuf)]);
}

function makeUuid(index) {
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function createConvDb(dbPath, steps, { walMode = false } = {}) {
  const db = new DatabaseSync(dbPath);
  if (walMode) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA wal_autocheckpoint = 0;');
  }
  db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
  const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
  for (const s of steps) {
    stmt.run(s.idx, s.stepType ?? 1, buildStepMetadata(s));
  }
  db.close();
}

function appendConvStep(dbPath, step, { walMode = false } = {}) {
  const db = new DatabaseSync(dbPath);
  if (walMode) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA wal_autocheckpoint = 0;');
  }
  db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(
    step.idx,
    step.stepType ?? 1,
    buildStepMetadata(step)
  );
  db.close();
}

function createSummaryDb(dbPath, entries) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      agent_name TEXT,
      step_count INTEGER,
      last_modified_time TEXT
    );
    CREATE TABLE IF NOT EXISTS conversation_parents (
      conversation_id TEXT PRIMARY KEY,
      parent_id TEXT
    );
  `);
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, parent_conversation_id, nesting_depth, agent_name, step_count, last_modified_time) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const e of entries) {
    stmt.run(e.cid, e.title || '', e.parent || '', e.depth || 0, e.agent || '', e.stepCount || 1, e.lastModifiedTime || '');
  }
  db.close();
}

const tempDirs = [];

function makeTempAppData() {
  const dir = mkdtempSync(join(tmpdir(), 'token-meter-test-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'conversations'), { recursive: true });
  mkdirSync(join(dir, 'brain'), { recursive: true });
  return dir;
}

afterEach(() => {
  delete process.env.TOKEN_METER_CACHE_LIMIT;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('CONV_CACHE_LIMIT configuration', () => {
  it('defaults to 2000 and supports TOKEN_METER_CACHE_LIMIT positive integer override', () => {
    assert.equal(CONV_CACHE_LIMIT, 2000);

    const engineDefault = new TokenMeterEngine(makeTempAppData());
    assert.equal(engineDefault.cacheLimit, 2000);

    for (const invalid of ['0', '-5', 'abc', '12.5', '']) {
      process.env.TOKEN_METER_CACHE_LIMIT = invalid;
      const eng = new TokenMeterEngine(makeTempAppData());
      assert.equal(eng.cacheLimit, 2000, `Expected fallback 2000 for invalid value "${invalid}"`);
    }

    process.env.TOKEN_METER_CACHE_LIMIT = '3500';
    const engineCustom = new TokenMeterEngine(makeTempAppData());
    assert.equal(engineCustom.cacheLimit, 3500);

    // Verify module-level export in subprocess when env var is set before import
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import { CONV_CACHE_LIMIT } from "./sidecars/meter/engine.mjs"; console.log(CONV_CACHE_LIMIT);',
      ],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, TOKEN_METER_CACHE_LIMIT: '42' },
        encoding: 'utf8',
      }
    );
    assert.equal(out.trim(), '42');
  });

  it('enforces TOKEN_METER_CACHE_LIMIT as LRU cache capacity', () => {
    const appDir = makeTempAppData();
    const convDir = join(appDir, 'conversations');
    const nowSec = Math.floor(Date.now() / 1000);
    const cids = [makeUuid(1), makeUuid(2), makeUuid(3)];
    for (const cid of cids) {
      createConvDb(join(convDir, `${cid}.db`), [{ idx: 0, tsSec: nowSec, uncachedInput: 10, cacheRead: 90, output: 5 }]);
    }

    process.env.TOKEN_METER_CACHE_LIMIT = '2';
    const engine = new TokenMeterEngine(appDir);
    assert.equal(engine.cacheLimit, 2);

    // Load 1, 2, then 3 (evicts 1). Touching 2 keeps 2, reading 1 again reloads without error.
    assert.equal(engine.readConversationStats(cids[0]).totalTokens, 105);
    assert.equal(engine.readConversationStats(cids[1]).totalTokens, 105);
    assert.equal(engine.readConversationStats(cids[2]).totalTokens, 105);
    assert.equal(engine.readConversationStats(cids[0]).totalTokens, 105);
  });
});

describe('getOverview directory mtime fast path', () => {
  it('avoids re-scanning thousands of cold .db files while catching new sessions and .db-wal appends', () => {
    const appDir = makeTempAppData();
    const convDir = join(appDir, 'conversations');
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const fiveDaysAgoMs = nowMs - 5 * 24 * 3600 * 1000;
    const fiveDaysAgoSec = Math.floor(fiveDaysAgoMs / 1000);
    const fiveDaysAgoDate = new Date(fiveDaysAgoMs);
    const fiveDaysAgoIso = fiveDaysAgoDate.toISOString();

    // Build 1,200 cold .db files efficiently by cloning a valid SQLite template DB
    const templateCid = makeUuid(1000);
    const templatePath = join(convDir, `${templateCid}.db`);
    createConvDb(templatePath, [{ idx: 0, tsSec: fiveDaysAgoSec, uncachedInput: 100, cacheRead: 100, output: 20 }]);
    const templateBytes = readFileSync(templatePath);
    utimesSync(templatePath, fiveDaysAgoDate, fiveDaysAgoDate);

    const summaryEntries = [{ cid: templateCid, title: 'cold-1000', lastModifiedTime: fiveDaysAgoIso }];
    const COLD_COUNT = 1200;
    for (let i = 1001; i < 1000 + COLD_COUNT; i++) {
      const cid = makeUuid(i);
      const p = join(convDir, `${cid}.db`);
      writeFileSync(p, templateBytes);
      utimesSync(p, fiveDaysAgoDate, fiveDaysAgoDate);
      summaryEntries.push({ cid, title: `cold-${i}`, lastModifiedTime: fiveDaysAgoIso });
    }

    // Add 1 active session in summary DB and 1 session from 20h ago (visible in 24h, excluded in today if before midnight)
    const activeCid1 = makeUuid(1);
    createConvDb(join(convDir, `${activeCid1}.db`), [
      { idx: 0, tsSec: nowSec - 10, uncachedInput: 200, cacheRead: 800, output: 50 },
    ]);
    summaryEntries.push({ cid: activeCid1, title: 'active-1', lastModifiedTime: new Date(nowMs).toISOString() });

    const yesterdayDate = new Date(nowMs);
    yesterdayDate.setHours(0, 0, 0, 0);
    const beforeMidnightSec = Math.floor((yesterdayDate.getTime() - 3600 * 1000) / 1000); // 1h before local midnight
    const yesterdayCid = makeUuid(2);
    createConvDb(join(convDir, `${yesterdayCid}.db`), [
      { idx: 0, tsSec: beforeMidnightSec, uncachedInput: 300, cacheRead: 700, output: 40 },
    ]);
    summaryEntries.push({
      cid: yesterdayCid,
      title: 'yesterday-before-midnight',
      lastModifiedTime: new Date(beforeMidnightSec * 1000).toISOString(),
    });

    createSummaryDb(join(appDir, 'conversation_summaries.db'), summaryEntries);

    const engine = new TokenMeterEngine(appDir);

    // 1. First scan builds dbMtimeIndex once
    const ov1 = engine.getOverview('today', true);
    const stats1 = engine.getOverviewScanStats();
    assert.equal(ov1.totals.sessions, 1);
    assert.equal(ov1.totals.calls, 1);
    assert.equal(ov1.totals.totalTokens, 1050);
    assert.equal(stats1.dirChanged, true);
    assert.equal(stats1.readdirCalls, 1);
    assert.equal(stats1.totalIndexed, COLD_COUNT + 2);

    // 2. Second scan (unchanged dir) skips readdirSync and avoids stating 1,200 cold files
    const ov2 = engine.getOverview('today', true);
    const stats2 = engine.getOverviewScanStats();
    assert.equal(ov2.totals.sessions, 1);
    assert.equal(ov2.totals.totalTokens, 1050);
    assert.equal(stats2.dirChanged, false);
    assert.equal(stats2.readdirCalls, 0);
    assert.ok(stats2.statCalls < 20, `Expected < 20 stats on fast path, got ${stats2.statCalls}`);

    // 3. Switching to 24h includes yesterday-before-midnight session without readdirSync
    const ov24h = engine.getOverview('24h', true);
    const stats24h = engine.getOverviewScanStats();
    assert.equal(ov24h.totals.sessions, 2);
    assert.equal(ov24h.totals.totalTokens, 1050 + 1040);
    assert.equal(stats24h.dirChanged, false);
    assert.equal(stats24h.readdirCalls, 0);

    // 4. Create brand-new WAL-mode session NOT in conversation_summaries.db and keep writer open so .db-wal stays active
    const brandNewCid = makeUuid(3);
    const brandNewPath = join(convDir, `${brandNewCid}.db`);
    const walDb = new DatabaseSync(brandNewPath);
    walDb.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    walDb.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);');
    const walInsert = walDb.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
    walInsert.run(0, 1, buildStepMetadata({ tsSec: nowSec - 2, uncachedInput: 500, cacheRead: 500, output: 100 }));
    walInsert.run(1, 1, buildStepMetadata({ tsSec: nowSec - 1, uncachedInput: 100, cacheRead: 900, output: 50 }));

    try {
      const ov3 = engine.getOverview('today', true);
      const stats3 = engine.getOverviewScanStats();
      assert.equal(stats3.dirChanged, true);
      assert.equal(stats3.readdirCalls, 1);
      // Dir changed, but only newly appeared + hot entries are stat'd, NOT the 1,200 cold DBs!
      assert.ok(stats3.statCalls < 20, `Expected < 20 stats on incremental dir-change scan, got ${stats3.statCalls}`);
      assert.equal(ov3.totals.sessions, 2);
      assert.equal(ov3.totals.calls, 3);
      assert.equal(ov3.totals.totalTokens, 1050 + 1100 + 1050);

      // 5. Append to existing .db-wal WITHOUT changing directory mtimeMs (still missing from summary DB)
      walInsert.run(2, 1, buildStepMetadata({ tsSec: nowSec, uncachedInput: 400, cacheRead: 600, output: 100 }));
      const ov4 = engine.getOverview('today', true);
      const stats4 = engine.getOverviewScanStats();
      assert.equal(stats4.dirChanged, false);
      assert.equal(stats4.readdirCalls, 0);
      assert.equal(ov4.totals.sessions, 2);
      assert.equal(ov4.totals.calls, 4);
      assert.equal(ov4.totals.totalTokens, 1050 + 1100 + 1050 + 1100);
    } finally {
      walDb.close();
    }

    // 6. Resuming a cold session updated in conversation_summaries.db is caught via summary pre-filter
    const resumedCid = makeUuid(1005);
    appendConvStep(join(convDir, `${resumedCid}.db`), {
      idx: 1,
      tsSec: nowSec,
      uncachedInput: 1000,
      cacheRead: 2000,
      output: 200,
    });
    summaryEntries.find((e) => e.cid === resumedCid).lastModifiedTime = new Date(nowMs).toISOString();
    createSummaryDb(join(appDir, 'conversation_summaries.db'), summaryEntries);

    const ov5 = engine.getOverview('today', true);
    assert.equal(ov5.totals.sessions, 3);
    assert.equal(ov5.totals.calls, 5);
    assert.equal(ov5.totals.totalTokens, 1050 + 1100 + 1050 + 1100 + 3200);
  });
});
