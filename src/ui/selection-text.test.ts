import { describe, expect, test } from 'bun:test';

import {
  overlaySelectionRootID,
  type SelectionNode,
  type SelectionSnapshot,
  selectionText,
} from './selection-text.ts';

type FakeNode = Readonly<{ node: SelectionNode; text: string }>;

function fakeNode(
  text: string,
  options: {
    parent?: FakeNode;
    id?: string;
    x?: number;
    y?: number;
    destroyed?: boolean;
  } = {},
): FakeNode {
  const holder = { text };
  const node: SelectionNode = {
    id: options.id ?? 'text',
    parent: options.parent?.node ?? null,
    x: options.x ?? 0,
    y: options.y ?? 0,
    get isDestroyed() {
      return options.destroyed ?? false;
    },
    getSelectedText: () => holder.text,
  };
  return { node, text };
}

function selection(nodes: readonly FakeNode[], joined: string): SelectionSnapshot {
  return {
    selectedRenderables: nodes.map((entry) => entry.node),
    getSelectedText: () => joined,
  };
}

describe('selection text projection (#issue 3)', () => {
  test('without an overlay, the renderer projection is returned unchanged', () => {
    const outside = fakeNode('conversation text');
    expect(selectionText(selection([outside], 'conversation text'), false)).toBe(
      'conversation text',
    );
    expect(selectionText(null, false)).toBe('');
  });

  test('with the inspector open, only its own renderables are copied', () => {
    const overlay = fakeNode('', { id: overlaySelectionRootID });
    const lineOne = fakeNode('payload one', { parent: overlay, x: 4, y: 3 });
    const lineTwo = fakeNode('payload two', { parent: overlay, x: 4, y: 4 });
    const hidden = fakeNode('hidden transcript', { x: 1, y: 10 });
    const copied = selectionText(selection([hidden, lineTwo, lineOne], 'ignored'), true);
    expect(copied).toBe('payload one\npayload two');
  });

  test('a selection that only touches text behind the inspector copies nothing', () => {
    const hidden = fakeNode('hidden transcript', { x: 1, y: 10 });
    expect(selectionText(selection([hidden], 'hidden transcript'), true)).toBe('');
  });

  test('destroyed renderables never contribute stale text', () => {
    const overlay = fakeNode('', { id: overlaySelectionRootID });
    const live = fakeNode('still here', { parent: overlay, y: 2 });
    const gone = fakeNode('destroyed row', { parent: overlay, y: 1, destroyed: true });
    expect(selectionText(selection([gone, live], 'stale'), true)).toBe('still here');
  });
});
