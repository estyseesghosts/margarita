import { describe, expect, test } from 'bun:test';

import { type AgentDescriptor, mentionableAgents, selectableAgents } from './agent-cycle.ts';
import { agentMentions, findFileMentions, isBareAgentNameMention } from './file-reference.ts';

const agent = (
  id: string,
  mode: AgentDescriptor['mode'] = 'primary',
  hidden = false,
): AgentDescriptor => ({ id, name: id, mode, hidden });

describe('primary-selectable vs mention-eligible agent catalogs (#133)', () => {
  test('subagent-only agents are excluded from the cycle but included for mentions', () => {
    const all = [
      agent('build'),
      agent('reviewer', 'subagent'),
      agent('plan'),
      agent('secret', 'primary', true),
    ];
    expect(selectableAgents(all, ['build', 'plan']).map((entry) => entry.id)).toEqual([
      'build',
      'plan',
    ]);
    expect(mentionableAgents(all).map((entry) => entry.id)).toEqual(['build', 'plan', 'reviewer']);
  });

  test('both catalogs de-duplicate by ID and ignore backend ordering', () => {
    const all = [agent('zeta'), agent('build'), agent('build'), agent('reviewer', 'subagent')];
    expect(selectableAgents(all, ['build']).map((entry) => entry.id)).toEqual(['build', 'zeta']);
    expect(mentionableAgents(all).map((entry) => entry.id)).toEqual(['build', 'reviewer', 'zeta']);
  });

  test('a mode:all agent is both selectable and mentionable', () => {
    const all = [agent('general', 'all')];
    expect(selectableAgents(all, []).map((entry) => entry.id)).toEqual(['general']);
    expect(mentionableAgents(all).map((entry) => entry.id)).toEqual(['general']);
  });

  test('bare-name classification is shared, path and range mentions are never agents', () => {
    const mentions = findFileMentions('ask @reviewer about @src/a.ts and @f.ts#1-9');
    expect(mentions.filter(isBareAgentNameMention).map((entry) => entry.path)).toEqual([
      'reviewer',
    ]);
    expect(agentMentions(mentions, new Set(['reviewer'])).map((entry) => entry.path)).toEqual([
      'reviewer',
    ]);
  });
});
