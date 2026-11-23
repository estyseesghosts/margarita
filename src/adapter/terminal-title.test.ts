import { describe, expect, test } from 'bun:test';

import { createTerminalTitlePublisher } from './terminal-title.ts';

function collector(enabled = true, style: 'osc0' | 'osc2' = 'osc0') {
  const sequences: string[] = [];
  const publisher = createTerminalTitlePublisher({
    write: (sequence) => sequences.push(sequence),
    enabled,
    style,
  });
  return { publisher, sequences };
}

describe('terminal title publisher (#329)', () => {
  test('publishes the selected session title as an OSC 0 sequence', () => {
    const { publisher, sequences } = collector();
    publisher.set({ title: 'Auditing Margarita...', directory: '/work' });
    expect(sequences).toEqual(['\u001b]0;MARG - Auditing Margarita...\u0007']);
    publisher.dispose();
  });

  test('supports OSC 2 for window-title-only hosts', () => {
    const { publisher, sequences } = collector(true, 'osc2');
    publisher.set({ directory: '/work/workdir' });
    expect(sequences).toEqual(['\u001b]2;MARG - workdir\u0007']);
    publisher.dispose();
  });

  test('only publishes when the effective title changes', () => {
    const { publisher, sequences } = collector();
    publisher.set({ title: 'same', directory: '/a' });
    publisher.set({ title: 'same', directory: '/b' });
    publisher.set({ title: 'different', directory: '/b' });
    expect(sequences).toHaveLength(2);
    publisher.dispose();
  });

  test('non-interactive output is never written', () => {
    const { publisher, sequences } = collector(false);
    publisher.set({ title: 'secret' }, '/work');
    publisher.restore();
    publisher.dispose();
    expect(sequences).toEqual([]);
  });

  test('hostile titles cannot inject another OSC sequence', () => {
    const { publisher, sequences } = collector();
    publisher.set({ title: 'ok\u001b]0;pwned\u0007\u001b[31mred\u001b[0m' });
    expect(sequences).toHaveLength(1);
    expect(sequences[0]).toBe('\u001b]0;MARG - okred\u0007');
    publisher.dispose();
  });

  test('dispose releases the title once and publishes nothing afterward', () => {
    const { publisher, sequences } = collector();
    publisher.set({ title: 'active' });
    publisher.dispose();
    expect(sequences.at(-1)).toBe('\u001b]0;\u0007');
    const count = sequences.length;
    publisher.set({ title: 'after dispose' });
    publisher.restore();
    expect(sequences).toHaveLength(count);
  });
});
