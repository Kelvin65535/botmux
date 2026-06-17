import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
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

  it('prepareMirHome repairs a dangling config.json symlink', () => {
    seedSharedMira();
    const home = sessionMiraHome('sess-dangle');
    mkdirSync(home, { recursive: true });
    // A leftover link pointing at a now-deleted old MIRA_HOME.
    const stale = join(tempHome, 'old-mira', 'config.json');
    symlinkSync(stale, join(home, 'config.json'));
    expect(existsSync(join(home, 'config.json'))).toBe(false); // dangling
    prepareMirHome('sess-dangle');
    const link = join(home, 'config.json');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(tempHome, '.mira', 'config.json'));
    expect(readFileSync(link, 'utf-8')).toContain('cookies');
  });

  it('prepareMirHome rewrites a symlink that points at the wrong target', () => {
    seedSharedMira();
    const home = sessionMiraHome('sess-wrong');
    mkdirSync(home, { recursive: true });
    const otherReal = join(tempHome, 'other-mira');
    mkdirSync(otherReal, { recursive: true });
    writeFileSync(join(otherReal, 'config.json'), '{"cookies":"STALE"}', 'utf-8');
    symlinkSync(join(otherReal, 'config.json'), join(home, 'config.json'));
    prepareMirHome('sess-wrong');
    expect(readlinkSync(join(home, 'config.json'))).toBe(join(tempHome, '.mira', 'config.json'));
  });

  it('prepareMirHome leaves a real (non-symlink) config.json untouched', () => {
    seedSharedMira();
    const home = sessionMiraHome('sess-realfile');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{"cookies":"USERPROVIDED"}', 'utf-8');
    prepareMirHome('sess-realfile');
    expect(lstatSync(join(home, 'config.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, 'config.json'), 'utf-8')).toContain('USERPROVIDED');
  });

  it('prepareMirHome skips the symlink when shared auth is absent (no crash)', () => {
    // No seedSharedMira(): ~/.mira/config.json does not exist.
    const home = prepareMirHome('sess-4');
    expect(existsSync(join(home, 'conversations'))).toBe(true);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });
});
