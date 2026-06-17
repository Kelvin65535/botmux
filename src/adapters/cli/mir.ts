import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { delay } from '../../utils/timing.js';
import type { CliAdapter, PtyHandle } from './types.js';

/**
 * Mir CLI (mircli) adapter — a Claude-Code-like interactive coding assistant.
 *
 * Interface highlights that make it a clean fit for a quiescence + readyPattern
 * PTY adapter (same family as coco / traex):
 *   - default mode is an interactive TUI whose input prompt is `❯` (U+276F),
 *     rendered via prompt_toolkit with bracketed-paste support;
 *   - `-y` / `--yolo` skips permission prompts (gated by disableCliBypass);
 *   - `--resume` (no arg) reopens the most recent conversation in the data dir;
 *   - auth cookies live in `<MIRA_HOME>/config.json` (`mircli login`).
 *
 * Two interactive-mode quirks force a per-session MIRA_HOME (see
 * services/mir-paths.ts, wired in worker.ts): mircli always prompts
 * `恢复上次对话? [y/N]` when a `last_conversation` pointer exists (blocking the
 * first message), and it ignores `--session-id` for the conversation filename
 * while tracking "the last conversation" via a single global pointer. Isolating
 * MIRA_HOME per session — with `last_conversation` cleared before spawn — gives
 * each session its own empty/single-conversation home, so the prompt never
 * fires and `--resume` unambiguously reopens that session's history.
 *
 * Caveat (documented, NOT handled here): mircli only operates on the local repo
 * when its MCP Bridge (`mircli mcp start`) is running — otherwise its only
 * general file/exec tool is the remote sandbox, which coding mode hard-blocks.
 * Whether to install the bridge is left to the operator.
 *
 * There is no `--model` flag — the model is a global file (`<MIRA_HOME>/model`,
 * default opus4.7) switched via `mircli model <name>`. So modelChoices is
 * intentionally undefined (setup skips the model prompt) and buildArgs ignores
 * the model field.
 */

export function createMirAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static fields
  // and must not shell out (see resolveCommand); the binary path is a
  // spawn-time concern.
  const rawBin = pathOverride ?? 'mircli';
  let cachedBin: string | undefined;
  return {
    id: 'mir',
    authPaths: ['~/.mira/config.json'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, disableCliBypass }) {
      const args: string[] = [];
      if (!disableCliBypass) args.push('-y');
      // Resume with NO id: the per-session MIRA_HOME holds exactly one
      // conversation, and `--resume` (no arg) loads the most recent one there.
      // (mircli's interactive mode doesn't honor --session-id for the
      // conversation filename, so a precise `--resume <id>` isn't needed —
      // isolation makes "most recent" unambiguous.)
      if (resume) args.push('--resume');
      // --session-id is harmless (used for backend session naming) and keeps a
      // stable id visible to mircli even though the on-disk file is uuid-named.
      args.push('--session-id', sessionId);
      return args;
    },

    // The conversation lives in this session's isolated MIRA_HOME, which a plain
    // user `mircli` (reading ~/.mira) won't see — so there's no portable
    // copy-paste resume command. Card falls back to a static note.
    buildResumeCommand() {
      return null;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // mircli reads input through prompt_toolkit with bracketed paste enabled,
      // so multi-line messages must arrive wrapped in paste markers — otherwise
      // embedded \n submit line-by-line. Same strategy as coco / traex: paste,
      // brief settle, then Enter.
      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          return false;
        }
      };

      try {
        if (pty.pasteText) pty.pasteText(content);
        else pty.write('\x1b[200~' + content + '\x1b[201~');
      } catch {
        return { submitted: false };
      }
      await delay(200);
      if (!trySendEnter()) return { submitted: false };
      // No cheap on-disk submit log to verify against, so assume OK — same as
      // the aiden / hermes adapters.
      return undefined;
    },

    async flushBeforeKill(pty: PtyHandle) {
      // mircli's interactive mode persists the conversation only every 10
      // messages or on a clean /exit — an abrupt kill (suspend/close) would drop
      // a short session's history and break a later `--resume`. Send `/save` and
      // give it a moment to write `<MIRA_HOME>/conversations/<id>.json`. The pane
      // is normally idle at close; if it's mid-turn this no-ops harmlessly.
      try {
        if (pty.sendText) pty.sendText('/save');
        else pty.write('/save');
        if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
        else pty.write('\r');
      } catch {
        return;
      }
      await delay(1500);
    },

    completionPattern: undefined,
    // Interactive input prompt marker: bold-green `❯` (U+276F).
    readyPattern: /❯/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
    // mircli scans personal skills from `Path.home()/.mira/skills/<key>/SKILL.md`
    // — keyed off $HOME, NOT MIRA_HOME (verified in mircli.py's user-skill
    // loader: `home = Path.home(); home/<tool>/skills`). So the per-session
    // MIRA_HOME redirect does NOT move the skill dir, and this static path is
    // where ensureCliSkills writes AND where mircli reads. (Installed skills only
    // fire when the MCP bridge is connected, but writing them is harmless.)
    skillsDir: '~/.mira/skills',
    // No per-spawn --model flag (model is a global file); leave modelChoices
    // undefined so setup skips the model prompt for this CLI.
  };
}

export const create = createMirAdapter;
