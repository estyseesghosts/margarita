import { For, Show } from 'solid-js';

import type { QueuedInput } from '../adapter/backend.ts';
import { sanitizeTerminalText as sanitizeText } from '../domain/sanitize-text.ts';
import { truncatePrompt } from '../domain/sticky-prompt.ts';
import type { Theme } from './theme.ts';

const maxItems = 3;

/**
 * Server-confirmed pending user follow-ups, rendered in the conversation activity region
 * immediately above the active task marker, using the same visual language as the user
 * message row. FIFO order; the next pending entry carries the steer-now hint below it.
 * Read-only: no clickable chrome, a single keyboard action owns it. A steering item is
 * already on its way and shows no hint.
 */
export function QueuedPreview(props: {
  items: readonly QueuedInput[];
  theme: Theme;
  width: number;
}) {
  const text = (item: QueuedInput) =>
    truncatePrompt(sanitizeText(item.text), Math.max(8, props.width - 6));
  const shown = () => props.items.slice(0, maxItems);
  const overflow = () => Math.max(0, props.items.length - maxItems);
  const firstQueue = () => props.items.findIndex((item) => item.delivery === 'queue');
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <For each={shown()}>
        {(item, index) => (
          <box flexDirection="column">
            <box backgroundColor={props.theme.userBg} flexDirection="row">
              <text fg={props.theme.dim}>{item.delivery === 'steer' ? ' ⤷ ' : ' ❯ '}</text>
              <text fg={item.delivery === 'steer' ? props.theme.dim : props.theme.text}>
                {text(item)}
              </text>
            </box>
            <Show when={index() === firstQueue() && item.delivery === 'queue'}>
              <text fg={props.theme.dim}>{'  └ Queued · ctrl+enter to steer now'}</text>
            </Show>
          </box>
        )}
      </For>
      <Show when={overflow() > 0}>
        <text fg={props.theme.dim}>{`  └ … and ${overflow()} more queued`}</text>
      </Show>
    </box>
  );
}
