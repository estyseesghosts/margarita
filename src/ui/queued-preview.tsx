import { For, Show } from 'solid-js';

import type { QueuedInput } from '../adapter/backend.ts';
import { nextQueuedUser } from '../adapter/wire-mapping.ts';
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
  /** Effective `composer.steer` label, absent when the action is unbound (#250). */
  steerKey: string | undefined;
}) {
  const text = (item: QueuedInput) =>
    truncatePrompt(sanitizeText(item.text), Math.max(8, props.width - 6));
  const steerHint = () => (props.steerKey === undefined ? '' : ` · ${props.steerKey} to steer now`);
  const nextSteerHint = () =>
    props.steerKey === undefined ? '' : ` · ${props.steerKey} to steer the next now`;
  const shown = () => props.items.slice(0, maxItems);
  const overflow = () => Math.max(0, props.items.length - maxItems);
  const hinted = () => nextQueuedUser(props.items);
  const hintHidden = () => {
    const target = hinted();
    return target !== undefined && !shown().includes(target);
  };
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <For each={shown()}>
        {(item) => (
          <box flexDirection="column">
            <box backgroundColor={props.theme.userBg} flexDirection="row">
              <text fg={props.theme.dim}>{item.delivery === 'steer' ? ' ⤷ ' : ' ❯ '}</text>
              <text fg={item.delivery === 'steer' ? props.theme.dim : props.theme.text}>
                {text(item)}
              </text>
            </box>
            <Show when={item === hinted()}>
              <text fg={props.theme.dim}>{`  └ Queued${steerHint()}`}</text>
            </Show>
          </box>
        )}
      </For>
      <Show when={overflow() > 0}>
        <text fg={props.theme.dim}>
          {`  └ … and ${overflow()} more queued${hintHidden() ? nextSteerHint() : ''}`}
        </text>
      </Show>
    </box>
  );
}
