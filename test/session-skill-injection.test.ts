import { describe, expect, it } from 'vitest';

import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

describe('session skill injection', () => {
  it('does not change prompt when no skill manifest is provided', () => {
    const base = buildNewTopicPrompt('hello', 's1', 'codex');

    expect(base).not.toContain('<botmux_skills');
  });

  it('injects skill catalog when manifest has priority skills', () => {
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        description: 'Deploy services',
        tags: ['sre'],
        rootDir: '/skills/deploy',
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: '/skills/deploy' },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prompt = buildNewTopicPrompt(
      'hello',
      's1',
      'codex',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { skillManifest: manifest },
    );

    expect(prompt).toContain('<botmux_skills mode="priority">');
    expect(prompt).toContain('botmux skill show deploy');
  });
});
