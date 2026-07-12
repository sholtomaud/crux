/**
 * lib/config.ts — ~/.crux/crux.json per-installation config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CruxConfig {
  ui_port:      number;
  llm_endpoint: string;
}

const DEFAULTS: CruxConfig = {
  ui_port:      8765,
  llm_endpoint: 'http://localhost:11434',
};

const CRUX_DIR     = join(homedir(), '.crux');
const CONFIG_PATH  = join(CRUX_DIR, 'crux.json');

export function readCruxConfig(): CruxConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeCruxConfig(patch: Partial<CruxConfig>): CruxConfig {
  const current = readCruxConfig();
  const updated  = { ...current, ...patch };
  mkdirSync(CRUX_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return updated;
}
