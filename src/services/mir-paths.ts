import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-session MIRA_HOME isolation for the Mir CLI (mircli) adapter.
 *
 * Why this exists — two quirks of mircli's *interactive* mode that break the
 * default botmux model ("session id IS the resume key, spawn in a shared data
 * dir"):
 *
 *   1. On startup mircli unconditionally re-reads `<MIRA_HOME>/last_conversation`
 *      (a pointer to the most recent conversation) and prompts
 *      `恢复上次对话 (id)? [y/N]` whenever it is non-empty — even when `--resume`
 *      was passed. That prompt renders BEFORE the `❯` input box, so botmux's
 *      first message would be typed into the y/N prompt.
 *   2. Interactive mode ignores `--session-id` for the conversation filename
 *      (it saves under a random uuid) and tracks "the last conversation" via a
 *      single global pointer file, so concurrent sessions of one bot race it.
 *
 * Fix: give each botmux session its own MIRA_HOME under
 * `~/.botmux/mir-homes/<sessionId>`, seeded with a symlink back to the shared
 * `~/.mira/config.json` (auth cookies; token refresh writes through the symlink
 * so login stays persistent). Then:
 *   - a fresh home has no `last_conversation` → no y/N prompt;
 *   - resume runs `mircli --resume` (no arg), which loads the home's single
 *     conversation; we still delete any `last_conversation` first so the prompt
 *     can't fire on resume either;
 *   - concurrent sessions never share the pointer.
 *
 * The conversation history lives in `<MIRA_HOME>/conversations/<id>.json` and is
 * deliberately NOT cleaned up on session close (resume needs it) — same
 * lifetime as the shared `~/.mira/conversations`.
 */

/** The shared mircli data dir that holds auth/login state. Honors an explicit
 *  MIRA_HOME in the daemon env, else `~/.mira`. */
export function realMiraHome(): string {
  const env = process.env.MIRA_HOME?.trim();
  return env && env.length > 0 ? env : join(homedir(), '.mira');
}

/** The isolated MIRA_HOME for a given botmux session. */
export function sessionMiraHome(sessionId: string): string {
  return join(homedir(), '.botmux', 'mir-homes', sessionId);
}

/** Files in the shared home that the per-session home symlinks back to, so auth
 *  (and the user's model choice) carry over and token refresh persists to the
 *  real file. Auth (`config.json`) is the only one that matters for login;
 *  `model` / `models.json` are best-effort niceties. */
const SEED_LINK_FILES = ['config.json', 'model', 'models.json'] as const;

function ensureSymlink(target: string, linkPath: string): void {
  // Only link when the real source exists; a missing config.json means the user
  // hasn't run `mircli login`, which mircli will surface itself.
  if (!existsSync(target)) return;
  // existsSync follows symlinks: an existing, non-dangling link is left as-is.
  if (existsSync(linkPath)) return;
  try {
    symlinkSync(target, linkPath);
  } catch {
    // Racing spawns of the same session, or a pre-existing dangling link — both
    // benign; mircli reads through whatever is there.
  }
}

/**
 * Ensure the per-session MIRA_HOME exists and is seeded, and clear its
 * `last_conversation` pointer so mircli won't prompt to resume. Idempotent:
 * safe to call before every spawn (fresh or resume). Returns the home path to
 * set as the child's MIRA_HOME.
 */
export function prepareMirHome(sessionId: string): string {
  const home = sessionMiraHome(sessionId);
  const real = realMiraHome();
  try {
    mkdirSync(join(home, 'conversations'), { recursive: true });
  } catch {
    // If the dir can't be created, fall through — mircli will create what it can
    // and the worst case is a degraded session, not a crash.
  }
  for (const name of SEED_LINK_FILES) {
    ensureSymlink(join(real, name), join(home, name));
  }
  // Drop the "resume last?" pointer. force:true → no throw when absent.
  try {
    rmSync(join(home, 'last_conversation'), { force: true });
  } catch {
    /* best-effort */
  }
  return home;
}
