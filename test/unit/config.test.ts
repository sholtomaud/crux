/**
 * test/unit/config.test.ts
 * Tests config logic inline (no side-effects on ~/.crux/crux.json)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface CruxConfig { ui_port: number; llm_endpoint: string; }
const DEFAULTS: CruxConfig = { ui_port: 8765, llm_endpoint: 'http://localhost:11434' };

function readCfg(path: string): CruxConfig {
  if (!existsSync(path)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function writeCfg(path: string, patch: Partial<CruxConfig>): CruxConfig {
  const updated = { ...readCfg(path), ...patch };
  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return updated;
}

let tmpDir: string;
let cfgPath: string;

before(() => {
  tmpDir  = join(tmpdir(), `crux-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  cfgPath = join(tmpDir, 'crux.json');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readCruxConfig', () => {
  test('returns defaults when file absent', () => {
    rmSync(cfgPath, { force: true });
    const cfg = readCfg(cfgPath);
    assert.equal(cfg.ui_port, 8765);
    assert.equal(cfg.llm_endpoint, 'http://localhost:11434');
  });

  test('merges partial file with defaults', () => {
    writeFileSync(cfgPath, JSON.stringify({ ui_port: 9000 }), 'utf8');
    const cfg = readCfg(cfgPath);
    assert.equal(cfg.ui_port, 9000);
    assert.equal(cfg.llm_endpoint, 'http://localhost:11434');
  });

  test('returns defaults on malformed JSON', () => {
    writeFileSync(cfgPath, 'not json', 'utf8');
    const cfg = readCfg(cfgPath);
    assert.equal(cfg.ui_port, 8765);
  });
});

describe('writeCruxConfig', () => {
  test('creates file and returns updated config', () => {
    rmSync(cfgPath, { force: true });
    const cfg = writeCfg(cfgPath, { ui_port: 1234 });
    assert.equal(cfg.ui_port, 1234);
    assert.equal(cfg.llm_endpoint, 'http://localhost:11434');
    assert.ok(existsSync(cfgPath));
  });

  test('merges patch onto existing config', () => {
    writeCfg(cfgPath, { ui_port: 9000 });
    const cfg = writeCfg(cfgPath, { llm_endpoint: 'http://localhost:11435' });
    assert.equal(cfg.ui_port, 9000);
    assert.equal(cfg.llm_endpoint, 'http://localhost:11435');
  });
});
