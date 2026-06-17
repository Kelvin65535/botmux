import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMirHome, realMiraHome, sessionMiraHome } from '../src/services/mir-paths.js';

let tempHome: string;
let oldHome: string | undefined;
let oldMiraHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mir-home-'));
  oldHome = process.env.HOME;
  oldMiraHome = process.env.MIRA_HOME;
  process.env.HOME = tempHome;
  delete process.env.MIRA_HOME;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldMiraHome === undefined) delete process.env.MIRA_HOME; else process.env.MIRA_HOME = oldMiraHome;
  rmSync(tempHome, { recursive: true, force: true });
});

/** Seed a shared ~/.mira with auth so the symlink target exists. */
function seedSharedMira(): string {
  const real = join(tempHome, '.mira');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'config.json'), '{"cookies":"abc"}', 'utf-8');
  return real;
}

describe('mir-paths', () => {
  it('realMiraHome honors MIRA_HOME, else ~/.mira', () => {
    expect(realMiraHome()).toBe(join(tempHome, '.mira'));
    process.env.MIRA_HOME = '/custom/mira';
    expect(realMiraHome()).toBe('/custom/mira');
  });

  it('sessionMiraHome is per-session under ~/.botmux/mir-homes', () => {
    expect(sessionMiraHome('sess-1')).toBe(join(tempHome, '.botmux', 'mir-homes', 'sess-1'));
  });

  it('prepareMirHome creates the conversations dir and symlinks shared auth', () => {
    seedSharedMira();
    const home = prepareMirHome('sess-1');
    expect(home).toBe(sessionMiraHome('sess-1'));
    expect(existsSync(join(home, 'conversations'))).toBe(true);
    const link = join(home, 'config.json');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Reads through the symlink to the shared auth.
    expect(readFileSync(link, 'utf-8')).toContain('cookies');
  });

  it('prepareMirHome deletes the last_conversation pointer (the y/N trigger)', () => {
    seedSharedMira();
    const home = sessionMiraHome('sess-2');
    mkdirSync(join(home, 'conversations'), { recursive: true });
    writeFileSync(join(home, 'last_conversation'), 'some-id', 'utf-8');
    prepareMirHome('sess-2');
    expect(existsSync(join(home, 'last_conversation'))).toBe(false);
  });

  it('prepareMirHome is idempotent and preserves existing conversations', () => {
    seedSharedMira();
    const home = prepareMirHome('sess-3');
    const conv = join(home, 'conversations', 'uuid.json');
    writeFileSync(conv, '{"id":"uuid"}', 'utf-8');
    writeFileSync(join(home, 'last_conversation'), 'uuid', 'utf-8');
    // Second call (a resume) must clear the pointer but keep the conversation.
    prepareMirHome('sess-3');
    expect(existsSync(conv)).toBe(true);
    expect(existsSync(join(home, 'last_conversation'))).toBe(false);
  });

  it('prepareMirHome skips the symlink when shared auth is absent (no crash)', () => {
    // No seedSharedMira(): ~/.mira/config.json does not exist.
    const home = prepareMirHome('sess-4');
    expect(existsSync(join(home, 'conversations'))).toBe(true);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });
});
