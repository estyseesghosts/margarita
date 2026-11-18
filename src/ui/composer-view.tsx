import type { Accessor } from 'solid-js';
import { For, Show } from 'solid-js';

import type { Completion, Notice } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { splitAtCursor } from '../domain/composer.ts';
import { formatFooter } from '../domain/footer.ts';
import { goalBadge } from '../domain/native-goal.ts';
import { directoryName } from '../domain/path-identity.ts';
import { executionLabel } from '../domain/session.ts';
import type { Theme } from './theme.ts';

/** Prompt rule, composer and completion list. The cursor is an inverse cell. */
export function ComposerView(props: { controller: AppController; theme: Theme; width: number }) {
  const state = props.controller.state;
  const active = () => state.route.kind !== 'overview' || state.overview.focus === 'composer';
  const parts = () => splitAtCursor(state.composer);
  const before = () => parts().before;
  // A newline under the cursor is drawn as a space cell and kept in the trailing text.
  const at = () => (parts().at === '' || parts().at === '\n' ? ' ' : parts().at);
  const after = () => (parts().at === '\n' ? `\n${parts().after}` : parts().after);
  const placeholder = () =>
    state.route.kind === 'overview'
      ? `New session in ${directoryName(state.overview.directory)}`
      : state.route.kind === 'new'
        ? `New session in ${directoryName(state.route.directory)} · ← overview`
        : '← overview · Shift+Tab agent · Ctrl+O details';
  const rule = () => '─'.repeat(Math.max(0, props.width));

  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={props.theme.border}>{rule()}</text>
      <box flexDirection="row">
        <text fg={active() ? props.theme.text : props.theme.dim}>❯ </text>
        <Show
          when={state.composer.text !== ''}
          fallback={
            <text>
              <span style={{ fg: props.theme.dim, bg: active() ? props.theme.dim : undefined }}>
                {' '}
              </span>
              <span style={{ fg: props.theme.dim }}>{placeholder()}</span>
            </text>
          }
        >
          <text fg={props.theme.text}>
            {before()}
            <span style={{ bg: active() ? props.theme.text : undefined, fg: '#000000' }}>
              {at()}
            </span>
            {after()}
          </text>
        </Show>
      </box>
      <text fg={props.theme.border}>{rule()}</text>
      <Show when={state.completion}>
        {(completion: Accessor<Completion>) => (
          <box flexDirection="column">
            <For each={completion().items.slice(0, 8)}>
              {(item, index) => (
                <text fg={index() === completion().index ? props.theme.accent : props.theme.dim}>
                  {`  ${item.label}  `}
                  <span style={{ fg: props.theme.dim }}>{item.detail}</span>
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  );
}

/** The only persistent chrome: one line under the composer (docs/13). */
export function Footer(props: { controller: AppController; theme: Theme; width: number }) {
  const state = props.controller.state;
  const line = () => {
    const session = props.controller.currentSession();
    if (session === undefined) {
      return formatFooter(
        {
          ...(state.overview.agent === undefined ? {} : { agent: state.overview.agent }),
          ...(state.overview.model === undefined ? {} : { model: state.overview.model }),
          state: state.stream === 'live' ? 'overview' : state.stream,
          queued: 0,
          stale: false,
        },
        props.width - 2,
      );
    }
    const inbox = state.inbox[session.id] ?? [];
    const badge = goalBadge(state.nativeGoals[session.id] ?? null, state.awaitingSteer[session.id]);
    return formatFooter(
      {
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.model === undefined ? {} : { model: session.model }),
        state: executionLabel(props.controller.executionOf(session.id)),
        ...(session.tokens === undefined ? {} : { tokens: session.tokens }),
        ...(session.cost === undefined ? {} : { cost: session.cost }),
        queued: inbox.length,
        stale: state.stream !== 'live',
        ...(badge === '' ? {} : { goal: badge }),
      },
      props.width - 2,
    );
  };
  const notice = () => state.notice;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <Show when={notice()}>
        {(current: Accessor<Notice>) => (
          <text
            fg={
              current().tone === 'error'
                ? props.theme.error
                : current().tone === 'warn'
                  ? props.theme.warn
                  : props.theme.dim
            }
          >
            {current().text}
          </text>
        )}
      </Show>
      <text fg={props.theme.dim}>{line()}</text>
    </box>
  );
}
