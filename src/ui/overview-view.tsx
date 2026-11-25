import type { ScrollBoxRenderable } from '@opentui/core';
import type { Accessor } from 'solid-js';
import { createEffect, For, Match, Show, Switch } from 'solid-js';

import type { AppController } from '../app/controller.ts';
import { groupRows, loadMoreRowKey, type OverviewRow } from '../domain/overview-groups.ts';
import {
  layoutOverviewRow,
  layoutOverviewTabs,
  layoutProjectHeader,
  overviewContentWidth,
  overviewMarker,
} from '../domain/overview-row-layout.ts';
import { directoryKey, directoryName } from '../domain/path-identity.ts';
import { projectLabel } from '../domain/project-label.ts';
import { sanitizeSingleLine } from '../domain/sanitize-text.ts';
import type { SessionSummary } from '../domain/session.ts';
import { executionLabel } from '../domain/session.ts';
import { formatAge } from '../domain/usage-format.ts';
import { strings } from '../i18n/index.ts';
import { useActivate } from './pointer.ts';
import { isNoColorTheme, type Theme } from './theme.ts';

type RowOf<K extends OverviewRow['kind']> = Extract<OverviewRow, { kind: K }>;

/**
 * Project-grouped session list (docs/04), most recently used first. Each project shows
 * six sessions; the rest expand inline behind a Show more/less row. Rows never animate.
 */
export function Overview(props: {
  controller: AppController;
  theme: Theme;
  now: number;
  width: number;
  ascii?: boolean;
}) {
  const state = props.controller.state;
  const activate = useActivate();
  const groups = () => props.controller.groups();
  const selected = (key: string) =>
    state.overview.focus === 'list' && state.overview.selectedRow === key;
  let box: ScrollBoxRenderable | undefined;
  /** Expansion changes row geometry without changing the selected key (#240). */
  const expansion = () => Object.keys(state.overview.expanded).toSorted().join('|');
  /** Paired hosts whose credentials restore after the shell mounts (#346). */
  const deferred = () => props.controller.deferredServerList();
  /** Keeps the selected row visible; only scrolls when it has moved outside the viewport. */
  createEffect(() => {
    expansion();
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
        <b>{strings.overview.title}</b>
      </text>
      <box flexDirection="row" marginBottom={1}>
        <For
          each={layoutOverviewTabs(
            (['all', 'local', 'remotes', 'active', 'needs-input'] as const).map((tab) => ({
              label: props.controller.tabLabel(tab),
              compactLabel: strings.overview.compactTabs[tab],
              tinyLabel: strings.overview.tinyTabs[tab],
              count: props.controller.tabCounts()[tab] ?? 0,
              selected: state.overview.tab === tab,
            })),
            overviewContentWidth(props.width),
          )}
        >
          {(tab, index) => (
            <text
              fg={
                (['all', 'local', 'remotes', 'active', 'needs-input'] as const)[index()] ===
                state.overview.tab
                  ? props.theme.accent
                  : props.theme.dim
              }
              onMouseUp={activate(() =>
                props.controller.setOverviewTab(
                  (['all', 'local', 'remotes', 'active', 'needs-input'] as const)[index()] ?? 'all',
                ),
              )}
            >
              {tab}
            </text>
          )}
        </For>
      </box>
      <Show when={groups().length === 0}>
        <text fg={props.theme.dim}>
          {state.startup.phase === 'loading' ? strings.overview.loading : strings.overview.empty}
        </text>
      </Show>
      <For each={groups()}>
        {(group) => {
          const remoteLabel = () =>
            group.remote
              ? `  ${props.ascii === true ? strings.overview.remoteAsciiMarker : strings.overview.remoteGlyph} ${group.serverLabel ?? strings.overview.remoteFallbackLabel}`
              : '';
          const staleLabel = () => (group.stale ? `  ${strings.overview.offlineMarker}` : '');
          const header = () =>
            layoutProjectHeader({
              name: group.name,
              extras: `${remoteLabel()}${staleLabel()}`,
              directory: group.directory,
              contentWidth: overviewContentWidth(props.width),
            });
          return (
            <box flexDirection="column" marginBottom={1}>
              <text>
                <Show
                  when={!isNoColorTheme(props.theme)}
                  fallback={
                    <span style={{ fg: props.theme.text }}>
                      <b>{header().name}</b>
                    </span>
                  }
                >
                  <span
                    style={{
                      bg: projectLabel(
                        group.serverID,
                        directoryKey(group.directory, props.controller.platformFor(group.serverID)),
                      ).background,
                      fg: projectLabel(
                        group.serverID,
                        directoryKey(group.directory, props.controller.platformFor(group.serverID)),
                      ).foreground,
                    }}
                  >
                    {' '}
                    <b>{header().name}</b>{' '}
                  </span>
                </Show>
                <Show when={group.remote}>
                  <span style={{ fg: props.theme.accent }}>{remoteLabel()}</span>
                </Show>
                <Show when={group.stale}>
                  <span style={{ fg: props.theme.dim }}>{staleLabel()}</span>
                </Show>
                <Show when={header().directory !== ''}>
                  <span style={{ fg: props.theme.dim }}>{`  ${header().directory}`}</span>
                </Show>
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
                          rowKey={row.key}
                          width={props.width}
                          ascii={props.ascii}
                        />
                      )}
                    </Match>
                    <Match when={row.kind === 'toggle' ? row : undefined}>
                      {(toggle: Accessor<RowOf<'toggle'>>) => (
                        <text
                          id={rowID(row.key)}
                          fg={selected(row.key) ? props.theme.accent : props.theme.dim}
                          onMouseUp={activate(() => props.controller.clickOverviewRow(row.key))}
                        >
                          {`${overviewMarker(selected(row.key), overviewContentWidth(props.width))}${
                            toggle().expanded
                              ? strings.overview.showLess
                              : strings.overview.showMore(toggle().hidden)
                          }`}
                        </text>
                      )}
                    </Match>
                  </Switch>
                )}
              </For>
            </box>
          );
        }}
      </For>
      <Show when={deferred().length > 0}>
        <For each={deferred()}>
          {(server) => (
            <text fg={server.state === 'unauthorized' ? props.theme.warn : props.theme.dim}>
              {server.state === 'unauthorized'
                ? strings.overview.pairedUnavailable(server.label)
                : strings.overview.restoringPaired(server.label)}
            </text>
          )}
        </For>
      </Show>
      <Show when={!state.sessionsComplete}>
        <text fg={props.theme.dim}>{strings.overview.recentOnly}</text>
        <text
          id={rowID(loadMoreRowKey)}
          fg={selected(loadMoreRowKey) ? props.theme.accent : props.theme.dim}
        >
          {`${overviewMarker(selected(loadMoreRowKey), overviewContentWidth(props.width))}${
            state.sessionsLoading
              ? strings.overview.loadingMore
              : state.sessionsError !== undefined
                ? strings.overview.retryLoadMore
                : strings.overview.loadMore
          }`}
        </text>
        <Show when={state.sessionsError !== undefined}>
          <text fg={props.theme.warn}>
            {strings.overview.couldNotLoadMore(state.sessionsError ?? '')}
          </text>
        </Show>
      </Show>
      <Show when={state.sessionsComplete && groups().length > 0}>
        <text fg={props.theme.dim}>{strings.overview.allLoaded}</text>
      </Show>
      <text fg={props.theme.dim} marginTop={1}>
        {strings.overview.newSessionIn(directoryName(state.overview.project.directory))}
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
  rowKey: string;
  width: number;
  ascii?: boolean | undefined;
}) {
  const activate = useActivate();
  const execution = () => props.controller.executionOf(props.session.id, props.session.serverID);
  const tasks = () => {
    const count = props.controller.planProgress(props.session.id, props.session.serverID);
    return count === undefined ? '' : strings.overview.tasksProgress(count.done, count.total);
  };
  const age = () => formatAge(props.controller.lastUsed(props.session), props.now);
  const status = () => `${executionLabel(execution())}${tasks()} · ${age()}`;
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
      working: props.theme.success,
      unknown: props.theme.dim,
    })[state()];
  const columns = () =>
    layoutOverviewRow({
      selected: props.selected,
      dot: dot(),
      title: sanitizeSingleLine(props.session.title ?? props.session.id),
      status: sanitizeSingleLine(status()),
      age: age(),
      contentWidth: overviewContentWidth(props.width),
    });
  return (
    <box
      id={props.id}
      flexDirection="column"
      flexShrink={0}
      onMouseUp={activate(() => props.controller.clickOverviewRow(props.rowKey))}
    >
      <box flexDirection="row">
        <text fg={props.selected ? props.theme.accent : props.theme.dim}>
          <span style={{ fg: props.selected ? props.theme.accent : props.theme.dim }}>
            {columns().marker}
          </span>
          <span style={{ fg: dotColor() }}>{columns().dot}</span>
          <span style={{ fg: props.theme.text }}>{columns().titleLines[0] ?? ''}</span>
          <Show when={columns().statusMode !== 'none'}>
            <span>{columns().gap}</span>
            <span style={{ fg: attention() ? props.theme.warn : props.theme.dim }}>
              {columns().status}
            </span>
          </Show>
        </text>
      </box>
      <Show when={columns().titleLines.length > 1}>
        <box flexDirection="row">
          <text fg={props.theme.text}>
            {`${' '.repeat(columns().indentCells)}${columns().titleLines[1] ?? ''}`}
          </text>
        </box>
      </Show>
    </box>
  );
}
