import type { ScrollBoxRenderable } from '@opentui/core';
import type { Accessor } from 'solid-js';
import { createEffect, For, Match, Show, Switch } from 'solid-js';

import type { AppController } from '../app/controller.ts';
import { groupRows, loadMoreRowKey, type OverviewRow } from '../domain/overview-groups.ts';
import { directoryKey, directoryName } from '../domain/path-identity.ts';
import { projectLabel } from '../domain/project-label.ts';
import type { SessionSummary } from '../domain/session.ts';
import { executionLabel } from '../domain/session.ts';
import { formatAge } from '../domain/usage-format.ts';
import type { Theme } from './theme.ts';

type RowOf<K extends OverviewRow['kind']> = Extract<OverviewRow, { kind: K }>;

/**
 * Project-grouped session list (docs/04), most recently used first. Each project shows
 * six sessions; the rest expand inline behind a Show more/less row. Rows never animate.
 */
export function Overview(props: {
  controller: AppController;
  theme: Theme;
  now: number;
  ascii?: boolean;
}) {
  const state = props.controller.state;
  const groups = () => props.controller.groups();
  const selected = (key: string) =>
    state.overview.focus === 'list' && state.overview.selectedRow === key;
  let box: ScrollBoxRenderable | undefined;
  /** Keeps the selected row visible; only scrolls when it has moved outside the viewport. */
  createEffect(() => {
    const key = state.overview.focus === 'list' ? state.overview.selectedRow : undefined;
    if (key === undefined || box === undefined) return;
    const scrollbox = box;
    scrollbox.afterLayout(() => {
      scrollbox.scrollChildIntoView(rowID(key), { align: 'nearest' });
    });
  });
  return (
    <scrollbox
      ref={(element: ScrollBoxRenderable) => {
        box = element;
      }}
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={props.theme.text} marginBottom={1}>
        <b>Sessions</b>
      </text>
      <text marginBottom={1}>
        <For each={['all', 'local', 'remotes', 'active', 'needs-input'] as const}>
          {(tab) => (
            <span
              style={{
                fg: state.overview.tab === tab ? props.theme.accent : props.theme.dim,
              }}
            >
              {`${state.overview.tab === tab ? '[' : ' '}${props.controller.tabLabel(tab)} ${props.controller.tabCounts()[tab]}${state.overview.tab === tab ? ']' : ' '} `}
            </span>
          )}
        </For>
      </text>
      <Show when={groups().length === 0}>
        <text fg={props.theme.dim}>No sessions yet. Type below to start one.</text>
      </Show>
      <For each={groups()}>
        {(group) => (
          <box flexDirection="column" marginBottom={1}>
            <text>
              <Show when={props.ascii !== true}>
                <span
                  style={{
                    bg: projectLabel(group.serverID, directoryKey(group.directory, 'linux'))
                      .background,
                    fg: projectLabel(group.serverID, directoryKey(group.directory, 'linux'))
                      .foreground,
                  }}
                >
                  {' ██ '}
                </span>
              </Show>
              <span style={{ fg: props.theme.text }}>
                <b>{group.name}</b>
              </span>
              <Show when={group.remote}>
                <span style={{ fg: props.theme.accent }}>
                  {`  ${props.ascii === true ? '[remote]' : '🖥'} ${group.serverLabel ?? 'remote'}`}
                </span>
              </Show>
              <Show when={group.stale}>
                <span style={{ fg: props.theme.dim }}>{'  [offline]'}</span>
              </Show>
              <span style={{ fg: props.theme.dim }}>{`  ${group.directory}`}</span>
            </text>
            <For each={groupRows(group, state.overview.expanded[group.key] === true)}>
              {(row) => (
                <Switch>
                  <Match when={row.kind === 'session' ? row : undefined}>
                    {(sessionRow: Accessor<RowOf<'session'>>) => (
                      <SessionLine
                        controller={props.controller}
                        theme={props.theme}
                        now={props.now}
                        session={sessionRow().session}
                        selected={selected(row.key)}
                        id={rowID(row.key)}
                        ascii={props.ascii}
                      />
                    )}
                  </Match>
                  <Match when={row.kind === 'toggle' ? row : undefined}>
                    {(toggle: Accessor<RowOf<'toggle'>>) => (
                      <text
                        id={rowID(row.key)}
                        fg={selected(row.key) ? props.theme.accent : props.theme.dim}
                      >
                        {`${selected(row.key) ? '  ❯ ' : '    '}${
                          toggle().expanded ? '[Show less]' : `[Show more] ${toggle().hidden}`
                        }`}
                      </text>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </box>
        )}
      </For>
      <Show when={!state.sessionsComplete}>
        <text fg={props.theme.dim}>Showing recent sessions only.</text>
        <text
          id={rowID(loadMoreRowKey)}
          fg={selected(loadMoreRowKey) ? props.theme.accent : props.theme.dim}
        >
          {`${selected(loadMoreRowKey) ? '  ❯ ' : '    '}${
            state.sessionsLoading
              ? '[Loading more sessions…]'
              : state.sessionsError !== undefined
                ? '[Retry loading sessions]'
                : '[Load more sessions]'
          }`}
        </text>
        <Show when={state.sessionsError !== undefined}>
          <text
            fg={props.theme.warn}
          >{`Could not load more sessions: ${state.sessionsError}`}</text>
        </Show>
      </Show>
      <Show when={state.sessionsComplete && groups().length > 0}>
        <text fg={props.theme.dim}>All sessions loaded.</text>
      </Show>
      <text fg={props.theme.dim} marginTop={1}>
        {`New session in: ${directoryName(state.overview.project.directory)}`}
      </text>
    </scrollbox>
  );
}

function rowID(key: string): string {
  return `overview-row:${key}`;
}

function SessionLine(props: {
  controller: AppController;
  theme: Theme;
  now: number;
  session: SessionSummary;
  selected: boolean;
  id: string;
  ascii?: boolean | undefined;
}) {
  const execution = () => props.controller.executionOf(props.session.id);
  const tasks = () => {
    const count = props.controller.planProgress(props.session.id);
    return count === undefined ? '' : ` · ${count.done}/${count.total} tasks`;
  };
  const status = () =>
    `${executionLabel(execution())}${tasks()} · ${formatAge(props.controller.lastUsed(props.session), props.now)}`;
  const state = () => props.controller.statusOf(props.session);
  const dot = () =>
    props.ascii === true
      ? { idle: 'o', failed: '!', 'needs-input': '?', working: '*', unknown: '.' }[state()]
      : { idle: '●', failed: '●', 'needs-input': '●', working: '●', unknown: '○' }[state()];
  const attention = () => state() === 'needs-input' || state() === 'failed';
  const dotColor = () =>
    ({
      idle: props.theme.dim,
      failed: props.theme.error,
      'needs-input': props.theme.warn,
      working: props.theme.accent,
      unknown: props.theme.dim,
    })[state()];
  return (
    <box id={props.id} flexDirection="row" flexShrink={0}>
      <text fg={props.selected ? props.theme.accent : props.theme.dim}>
        {props.selected ? '  ❯ ' : '    '}
      </text>
      <text fg={dotColor()}>{`${dot()} `}</text>
      <text flexGrow={1} fg={props.theme.text}>
        {props.session.title ?? props.session.id}
      </text>
      <text fg={attention() ? props.theme.warn : props.theme.dim}>{` ${status()}`}</text>
    </box>
  );
}
