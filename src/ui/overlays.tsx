import { useTerminalDimensions } from '@opentui/solid';
import type { Accessor } from 'solid-js';
import { createMemo, For, Match, Show, Switch } from 'solid-js';

import type { DiffOverlay, Overlay } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { caretPaint } from '../domain/composer.ts';
import {
  diffSummary,
  diffWindowRows,
  type FileDiff,
  type PatchLine,
  patchLinesFor,
} from '../domain/diff.ts';
import {
  choiceWindow,
  currentField,
  type FormEditor,
  type FormField,
  type FormRequest,
  multiChoices,
  visibleFields,
} from '../domain/form.ts';
import { type Goal, progress, type TaskState } from '../domain/goal-plan.ts';
import { actionHint, actionIDs, formatBinding, type Keymap } from '../domain/keymap.ts';
import { formatModelRef } from '../domain/model-ref.ts';
import type { NativeGoal } from '../domain/native-goal.ts';
import { rewindTimeLabel } from '../domain/rewind.ts';
import { sanitizeTerminalText } from '../domain/sanitize-text.ts';
import type { SessionSummary, TokenUsage } from '../domain/session.ts';
import { localCommands } from '../domain/slash-command.ts';
import { cellWidth, sliceCells } from '../domain/text-width.ts';
import { completenessLabel } from '../domain/transcript.ts';
import { formatCost, formatTokenCount } from '../domain/usage-format.ts';
import { strings } from '../i18n/index.ts';
import { useActivate } from './pointer.ts';
import type { Theme } from './theme.ts';

const PICKER_MAX_ROWS = 10;

/**
 * A bounded window around the highlighted row (#267). The selected row stays visible at
 * every terminal height; the window is centered except at the list's edges.
 */
function pickerWindow(index: number, count: number, rows: number): { start: number; end: number } {
  const total = Math.max(0, count);
  const size = Math.min(total, Math.max(1, Math.floor(rows)));
  if (size === 0) return { start: 0, end: 0 };
  const selected = Math.max(0, Math.min(total - 1, index));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
  return { start, end: start + size };
}

/** Percentage for compact analytics rows; `N/A` when there is no denominator. */
function analyticsPercent(value: number | undefined): string {
  return value === undefined ? strings.overlays.usage.notApplicable : `${Math.round(value)}%`;
}

/** Bounded help rows: every action plus the two global fallbacks (#241). */
function helpRows(keymap: Keymap): { label: string; detail: string }[] {
  return [
    ...actionIDs.map((action) => {
      const bindings = keymap.get(action);
      const label =
        bindings === undefined || bindings.length === 0
          ? strings.overlays.keys.unbound
          : bindings.map(formatBinding).join(' / ');
      return { label, detail: action };
    }),
    { label: strings.overlays.keys.left, detail: strings.overlays.keys.leftDetail },
    {
      label: strings.overlays.keys.interrupt,
      detail: strings.overlays.keys.interruptDetail,
    },
  ];
}

/** Focused dialogs drawn above the composer. They are overlays, never routes. */
export function OverlayView(props: { controller: AppController; keymap: Keymap; theme: Theme }) {
  const state = props.controller.state;
  const terminal = useTerminalDimensions();
  /** Body rows shared by variable-length dialogs; never grows past the terminal (#241). */
  const bodyRows = () => Math.max(3, terminal().height - 12);
  /**
   * Actual option rows after the frame border, query and position line (#267). A short
   * terminal shows fewer options instead of clipping the highlighted one.
   */
  const pickerRows = () => Math.max(1, Math.min(PICKER_MAX_ROWS, terminal().height - 9));
  const frame = (title: string) => ({
    border: true,
    borderStyle: 'rounded' as const,
    borderColor: props.theme.border,
    title: ` ${title} `,
    flexDirection: 'column' as const,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
    // Reserve the composer, footer and a little breathing room on every terminal size.
    maxHeight: Math.max(6, terminal().height - 5),
  });
  const dim = () => props.theme.dim;
  const activate = useActivate();

  // One projector feeds the footer meter and this summary, so /usage and a context click
  // always show the same numbers (#124).
  const usage = () => props.controller.usageAnalytics();
  const contextLine = (): string => {
    const context = usage().context;
    if (context.status === 'pending') return strings.overlays.usage.contextPending;
    if (context.status === 'unknown' || context.tokens === undefined) {
      return strings.overlays.usage.contextUnknown;
    }
    const tokens = strings.overlays.usage.contextLine(formatTokenCount(context.tokens));
    if (context.limit === undefined || context.occupancy === undefined) {
      return strings.overlays.usage.contextLimitUnknown(tokens);
    }
    return strings.overlays.usage.contextWithLimit(
      tokens,
      formatTokenCount(context.limit),
      Math.round(context.occupancy),
    );
  };

  return (
    <Switch>
      <Match when={state.overlay.kind === 'help' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'help' }>>) => {
          const start = () =>
            Math.max(
              0,
              Math.min(
                overlay().offset ?? 0,
                Math.max(0, helpRows(props.keymap).length - bodyRows()),
              ),
            );
          const shown = () => helpRows(props.keymap).slice(start(), start() + bodyRows());
          return (
            <box {...frame(strings.overlays.keys.helpTitle)}>
              <For each={shown()}>
                {(row) => (
                  <text fg={props.theme.text}>
                    {row.label.padEnd(16)}
                    <span style={{ fg: dim() }}>{row.detail}</span>
                  </text>
                )}
              </For>
              <text fg={dim()}>
                {strings.overlays.keys.helpRows(
                  start() + 1,
                  start() + shown().length,
                  helpRows(props.keymap).length,
                )}
              </text>
              <text fg={dim()} marginTop={1}>
                {Object.keys(localCommands)
                  .map((name) => `/${name}`)
                  .join(' ')}
              </text>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'inspector' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'inspector' }>>) => {
          const dimensions = useTerminalDimensions();
          const rows = () => Math.max(4, dimensions().height - 12);
          // One logical line is one physical row: skip the border, padding and line number.
          const lineWidth = () => Math.max(8, dimensions().width - 12);
          const view = () => props.controller.inspectorView(rows());
          const matches = () => props.controller.inspectorMatches();
          const matchCount = () => matches().length;
          const shown = () => view();
          const visibleLine = (line: string) =>
            sliceCells(sanitizeTerminalText(line), overlay().column, lineWidth());
          return (
            <box
              border
              borderStyle="rounded"
              borderColor={props.theme.border}
              title={strings.overlays.inspector.title(overlay().title)}
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              flexGrow={1}
              flexShrink={1}
            >
              <box flexDirection="row">
                <text fg={props.theme.dim}>
                  {strings.overlays.inspector.lineSummary(
                    view().total.toLocaleString(),
                    shown().offset + 1,
                    shown().offset + shown().lines.length,
                  )}
                </text>
                <text fg={props.theme.dim}>
                  {strings.overlays.inspector.source(
                    completenessLabel(overlay().payload?.completeness ?? 'complete'),
                  )}
                </text>
                <Show when={overlay().loading}>
                  <text fg={props.theme.accent}>{strings.overlays.inspector.fetching}</text>
                </Show>
              </box>
              <Show when={overlay().error}>
                {(error: Accessor<string>) => <text fg={props.theme.warn}>{`  ${error()}`}</text>}
              </Show>
              <Show
                when={overlay().searching}
                fallback={<text fg={props.theme.dim}>{strings.overlays.inspector.hints}</text>}
              >
                <text fg={props.theme.accent}>
                  {strings.overlays.inspector.searchPrompt(
                    `${overlay().query.slice(0, overlay().queryCursor)}▏${overlay().query.slice(overlay().queryCursor)}`,
                    matchCount(),
                  )}
                </text>
              </Show>
              <box flexDirection="column" flexGrow={1} flexShrink={1}>
                <For each={shown().lines}>
                  {(line, index) => {
                    const lineNumber = () => shown().offset + index() + 1;
                    // Membership comes from the memoized match set, never a per-row rescan (#234).
                    const isMatch = () => props.controller.inspectorMatch(shown().offset + index());
                    return (
                      <box flexDirection="row">
                        <text
                          fg={props.theme.dim}
                        >{`${lineNumber().toString().padStart(6)}  `}</text>
                        <text fg={isMatch() ? props.theme.accent : props.theme.text}>
                          {visibleLine(line).text}
                        </text>
                      </box>
                    );
                  }}
                </For>
                <Show when={view().total === 0}>
                  <text fg={props.theme.dim}>{strings.overlays.inspector.noRetainedText}</text>
                </Show>
              </box>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'usage'}>
        <box {...frame(strings.overlays.usage.title)}>
          <text fg={props.theme.text}>
            {strings.overlays.usage.sessionLine(usage().sessionID, usage().serverID, usage().stale)}
          </text>
          <text fg={props.theme.text}>{contextLine()}</text>
          <Show when={usage().context.sinceCompaction !== undefined}>
            <text fg={dim()}>
              {strings.overlays.usage.sinceCompaction(
                formatTokenCount(usage().context.sinceCompaction ?? 0),
                usage().completedCompactions,
              )}
            </text>
          </Show>
          <Show when={usage().lastCompactionAt !== undefined}>
            <text fg={dim()}>
              {strings.overlays.usage.lastCompaction(
                new Date(usage().lastCompactionAt ?? 0).toISOString(),
              )}
            </text>
          </Show>
          <text fg={props.theme.text}>{strings.overlays.usage.lifetimeHeading}</text>
          <Show
            when={usage().lifetime}
            fallback={<text fg={dim()}>{strings.overlays.usage.lifetimeUnreported}</text>}
          >
            {(tokens: Accessor<TokenUsage>) => (
              <>
                <text fg={dim()}>
                  {strings.overlays.usage.lifetimeCounts(
                    formatTokenCount(tokens().input),
                    formatTokenCount(tokens().output),
                    formatTokenCount(tokens().reasoning),
                  )}
                </text>
                <text fg={dim()}>
                  {strings.overlays.usage.lifetimeCache(
                    formatTokenCount(tokens().cacheRead),
                    formatTokenCount(tokens().cacheWrite),
                  )}
                </text>
              </>
            )}
          </Show>
          <text fg={props.theme.text}>
            {strings.overlays.usage.spend(
              usage().cost === undefined
                ? strings.overlays.usage.notReported
                : formatCost(usage().cost),
            )}
          </text>
          <text fg={props.theme.text}>{strings.overlays.usage.activityHeading}</text>
          <text fg={dim()}>
            {strings.overlays.usage.toolTurns(
              usage().toolUsingTurns,
              usage().completedUserTurns,
              analyticsPercent(usage().toolTurnPercent),
              usage().toolCalls,
            )}
          </text>
          <text fg={dim()}>{strings.overlays.usage.toolCategoryLine(usage().toolCategories)}</text>
          <text fg={dim()}>
            {strings.overlays.usage.outcomes(
              usage().toolCompleted,
              usage().toolFailed,
              usage().toolRunning,
              usage().toolOther,
              analyticsPercent(usage().toolFailurePercent),
            )}
          </text>
          <text fg={dim()}>{strings.overlays.usage.loadedOnly}</text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'status'}>
        <box {...frame(strings.overlays.status.title)}>
          <text fg={props.theme.text}>
            {strings.overlays.status.server(props.controller.serverUrl)}
          </text>
          <text fg={props.theme.text}>{strings.overlays.status.stream(state.stream)}</text>
          <text fg={props.theme.text}>
            {strings.overlays.status.project(props.controller.currentDirectory())}
          </text>
          <Show when={props.controller.currentSession()}>
            {(session: Accessor<SessionSummary>) => (
              <text fg={props.theme.text}>{strings.overlays.status.session(session().id)}</text>
            )}
          </Show>
          <text fg={dim()}>{strings.chrome.productVersion(props.controller.version)}</text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'servers'}>
        <box {...frame(strings.overlays.servers.title)}>
          <For each={props.controller.serverList()}>
            {(server) => (
              <text fg={server.active ? props.theme.accent : props.theme.text}>
                {strings.overlays.servers.row(
                  server.active ? '❯' : ' ',
                  server.label,
                  server.baseUrl,
                  server.state,
                )}
              </text>
            )}
          </For>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'unpair-confirm' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'unpair-confirm' }>>) => (
          <box {...frame(strings.overlays.servers.unpairTitle)}>
            <text fg={props.theme.text}>
              {strings.overlays.servers.unpairConfirm(overlay().label)}
            </text>
            <text fg={dim()}>{strings.overlays.servers.unpairDetail}</text>
          </box>
        )}
      </Match>
      <Match when={state.overlay.kind === 'queue' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'queue' }>>) => {
          const start = () =>
            Math.max(
              0,
              Math.min(
                overlay().index - bodyRows() + 1,
                queuedItems(props.controller).length - bodyRows(),
              ),
            );
          const shown = () => queuedItems(props.controller).slice(start(), start() + bodyRows());
          return (
            <box {...frame(strings.overlays.queue.title)}>
              <Show
                when={queuedItems(props.controller).length > 0}
                fallback={<text fg={dim()}>{strings.overlays.queue.empty}</text>}
              >
                <For each={shown()}>
                  {(item, index) => {
                    const position = () => start() + index();
                    const label = strings.overlays.queue.row(
                      position() === overlay().index ? '❯' : ' ',
                      item.delivery,
                      sanitizeTerminalText(item.text.split('\n')[0] ?? ''),
                    );
                    return (
                      <text
                        fg={position() === overlay().index ? props.theme.accent : props.theme.text}
                      >
                        {sliceCells(label, 0, Math.max(10, terminal().width - 4)).text}
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {strings.overlays.queue.position(
                    overlay().index + 1,
                    queuedItems(props.controller).length,
                  )}
                </text>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'model-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'model-picker' }>>) => {
          const choices = () => props.controller.modelChoices(overlay().query);
          const view = () => pickerWindow(overlay().index, choices().length, pickerRows());
          return (
            <box
              {...frame(
                state.route.kind === 'conversation'
                  ? strings.overlays.model.titleConversation
                  : strings.overlays.model.titleNewSession,
              )}
            >
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>{strings.overlays.model.empty}</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(choice, index) => {
                    const absolute = () => view().start + index();
                    const selected = () => absolute() === overlay().index;
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseUp={activate(() => {
                          props.controller.selectModelPickerIndex(absolute());
                          void props.controller.acceptModelPicker();
                        })}
                      >
                        {
                          sliceCells(
                            `${selected() ? '❯' : ' '} ${formatModelRef(choice)}`,
                            0,
                            Math.max(10, terminal().width - 6),
                          ).text
                        }
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {strings.overlays.model.position(overlay().index + 1, choices().length)}
                </text>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'effort-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'effort-picker' }>>) => {
          const choices = () => props.controller.effortChoices(overlay().query);
          const view = () => pickerWindow(overlay().index, choices().length, pickerRows());
          const current = () => props.controller.currentEffort();
          return (
            <box {...frame(strings.overlays.effort.effortTitle)}>
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>{strings.overlays.effort.noVariants}</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(choice, index) => {
                    const absolute = () => view().start + index();
                    const selected = () => absolute() === overlay().index;
                    const active = () => choice.variant === current();
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseUp={activate(() => {
                          props.controller.selectEffortPickerIndex(absolute());
                          void props.controller.acceptEffortPicker();
                        })}
                      >
                        {
                          sliceCells(
                            `${selected() ? '❯' : ' '} ${choice.label}${active() ? strings.overlays.effort.current : ''}`,
                            0,
                            Math.max(10, terminal().width - 6),
                          ).text
                        }
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {strings.overlays.effort.position(overlay().index + 1, choices().length)}
                </text>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'agent-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'agent-picker' }>>) => {
          const choices = () => props.controller.agentChoices(overlay().query);
          const view = () => pickerWindow(overlay().index, choices().length, pickerRows());
          const current = () => props.controller.currentAgentID();
          return (
            <box
              {...frame(
                state.route.kind === 'conversation'
                  ? strings.overlays.agent.titleConversation
                  : strings.overlays.agent.titleNewSession,
              )}
            >
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>{strings.overlays.agent.empty}</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(agent, index) => {
                    const absolute = () => view().start + index();
                    const selected = () => absolute() === overlay().index;
                    const active = () => agent.id === current();
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseUp={activate(() => {
                          props.controller.selectAgentPickerIndex(absolute());
                          void props.controller.acceptAgentPicker();
                        })}
                      >
                        {
                          sliceCells(
                            `${selected() ? '❯' : ' '} ${agent.id}  ${active() ? strings.overlays.agent.currentLabel : ''}${agent.description ?? ''}`,
                            0,
                            Math.max(10, terminal().width - 6),
                          ).text
                        }
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {strings.overlays.agent.position(overlay().index + 1, choices().length)}
                </text>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'copy-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'copy-picker' }>>) => {
          const choices = () => props.controller.copyChoices(overlay().query);
          const view = () => pickerWindow(overlay().index, choices().length, pickerRows());
          return (
            <box {...frame(strings.overlays.copy.title)}>
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>{strings.overlays.copy.empty}</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(item, index) => {
                    const selected = () => view().start + index() === overlay().index;
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseUp={activate(() => {
                          props.controller.selectCopyPickerIndex(view().start + index());
                          void props.controller.acceptCopyPicker();
                        })}
                      >
                        {
                          sliceCells(
                            `${selected() ? '❯' : ' '} ${item.label}`,
                            0,
                            Math.max(10, terminal().width - 6),
                          ).text
                        }
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {strings.overlays.copy.position(overlay().index + 1, choices().length)}
                </text>
              </Show>
              <text fg={dim()}>{strings.overlays.copy.unretainedHint}</text>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'tasks' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'tasks' }>>) => (
          <TasksDialog
            controller={props.controller}
            theme={props.theme}
            index={overlay().index}
            frame={frame}
          />
        )}
      </Match>
      <Match when={state.overlay.kind === 'rewind-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'rewind-picker' }>>) => {
          const choices = () =>
            props.controller.rewindChoices(overlay().sessionID, overlay().serverID);
          const view = () => pickerWindow(overlay().index, choices().length, pickerRows());
          return (
            <box {...frame(strings.overlays.rewind.title)}>
              <text fg={props.theme.text}>
                {strings.overlays.rewind.promptPicker(choices().length, overlay().index + 1)}
              </text>
              <For each={choices().slice(view().start, view().end)}>
                {(choice, index) => {
                  const position = () => view().start + index();
                  const selected = () => position() === overlay().index;
                  return (
                    <text fg={selected() ? props.theme.accent : props.theme.text}>
                      {
                        sliceCells(
                          `${selected() ? '❯' : ' '} ${choice.ordinal}. ${rewindTimeLabel(choice.createdAt)}  ${choice.text}`,
                          0,
                          Math.max(10, terminal().width - 6),
                        ).text
                      }
                    </text>
                  );
                }}
              </For>
              <text fg={props.theme.text}>
                {strings.overlays.rewind.scope(
                  String(choices()[overlay().index]?.ordinal ?? '?'),
                  overlay().loading
                    ? strings.overlays.rewind.reading
                    : overlay().previewUnavailable
                      ? strings.overlays.rewind.scopeUnavailable
                      : diffSummary(overlay().files),
                )}
              </text>
              <For each={overlay().files.slice(0, 4)}>
                {(file) => (
                  <text fg={dim()}>{`  ${file.file}  +${file.additions} −${file.deletions}`}</text>
                )}
              </For>
              <text fg={dim()}>{strings.overlays.rewind.filesOnly}</text>
              <text fg={dim()}>{strings.overlays.rewind.utc}</text>
              <text fg={dim()}>{strings.overlays.rewind.staging}</text>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'revert' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'revert' }>>) => (
          <box {...frame(strings.overlays.revert.title)}>
            <text fg={props.theme.text}>
              {strings.overlays.revert.confirm(diffSummary(overlay().files))}
            </text>
            <For each={overlay().files.slice(0, pickerRows())}>
              {(file) => (
                <text fg={dim()}>{`  ${file.file}  +${file.additions} −${file.deletions}`}</text>
              )}
            </For>
            <Show when={overlay().busy}>
              <text fg={dim()}>{strings.overlays.revert.working}</text>
            </Show>
          </box>
        )}
      </Match>
      <Match when={state.overlay.kind === 'diff' ? state.overlay : undefined}>
        {(overlay: Accessor<DiffOverlay>) => (
          <DiffDialog
            controller={props.controller}
            overlay={overlay()}
            theme={props.theme}
            frame={frame}
          />
        )}
      </Match>
      <Match when={state.overlay.kind === 'form' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'form' }>>) => (
          <Show
            when={props.controller.openFormRequest()}
            fallback={<text fg={dim()}>{strings.overlays.form.answeredOrWithdrawn}</text>}
          >
            {(form: Accessor<FormRequest>) => (
              <FormDialog
                controller={props.controller}
                form={form()}
                editor={overlay().editor}
                theme={props.theme}
                frame={frame}
              />
            )}
          </Show>
        )}
      </Match>
      <Match when={state.overlay.kind === 'history-search' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'history-search' }>>) => (
          <box
            {...frame(
              strings.overlays.history.title(actionHint(props.keymap, 'history.search') ?? ''),
            )}
          >
            <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
            <text fg={dim()}>
              {props.controller.historySearchMatch() ?? strings.overlays.history.noMatch}
            </text>
          </box>
        )}
      </Match>
    </Switch>
  );
}

type Frame = (title: string) => Record<string, unknown>;

const statusMark = { added: 'A', deleted: 'D', modified: 'M' } as const;

/** File list, or one file's colored patch; everything comes from `session.diff`. */
function DiffDialog(props: {
  controller: AppController;
  overlay: DiffOverlay;
  theme: Theme;
  frame: Frame;
}) {
  const terminal = useTerminalDimensions();
  const activate = useActivate();
  const file = () => props.overlay.files[props.overlay.index];
  const scopeLabel = () =>
    props.overlay.scope === 'turn' ? strings.overlays.diff.thisTurn : strings.overlays.diff.session;
  const width = () => Math.max(8, terminal().width - 6);
  /** Frame border/title is outside the row budget; the footer keeps totals visible. */
  const pageRows = () => diffWindowRows(terminal().height);
  const title = (text: string) =>
    props.frame(sliceCells(text, 0, Math.max(8, terminal().width - 4)).text);
  const fileRows = () => pickerWindow(props.overlay.index, props.overlay.files.length, pageRows());
  // A file object is immutable across scroll keys. Reformat only when the opened file or
  // scope changes, never once per rendered row or keypress (#276).
  const lines = createMemo<readonly PatchLine[]>(() => {
    const current = file();
    return current === undefined ? [] : patchLinesFor(current);
  });
  /** Keep the logical offset visible; fill the window at the end instead of leaving it blank. */
  const firstLine = () => Math.min(props.overlay.offset, Math.max(0, lines().length - pageRows()));
  const lineColor = (kind: PatchLine['kind']) => {
    switch (kind) {
      case 'add':
        return props.theme.success;
      case 'del':
        return props.theme.error;
      case 'hunk':
        return props.theme.accent;
      case 'meta':
        return props.theme.dim;
      default:
        return props.theme.text;
    }
  };
  /** One physical row per file: clip the prefix, path and counters in order. */
  const fileRow = (entry: FileDiff, selected: boolean) => {
    let budget = width();
    const mark = sliceCells(`${selected ? '❯' : ' '} ${statusMark[entry.status]} `, 0, budget).text;
    budget -= cellWidth(mark);
    const path = sliceCells(entry.file, 0, budget).text;
    budget -= cellWidth(path);
    const added = sliceCells(`  +${entry.additions}`, 0, budget).text;
    budget -= cellWidth(added);
    const removed = sliceCells(` −${entry.deletions}`, 0, budget).text;
    return { mark, path, added, removed };
  };
  return (
    <Switch>
      <Match when={props.overlay.open ? file() : undefined}>
        {(current: Accessor<FileDiff>) => {
          const shown = () => Math.min(pageRows(), Math.max(0, lines().length - firstLine()));
          return (
            <box {...title(strings.overlays.diff.title(current().file))}>
              <For each={lines().slice(firstLine(), firstLine() + pageRows())}>
                {(line) => (
                  <text fg={lineColor(line.kind)}>
                    {sliceCells(line.text === '' ? ' ' : line.text, 0, width()).text}
                  </text>
                )}
              </For>
              <text fg={props.theme.dim}>
                {lines().length === 0
                  ? strings.overlays.diff.noPatchLines(
                      props.overlay.index + 1,
                      props.overlay.files.length,
                    )
                  : sliceCells(
                      `${strings.overlays.diff.position(
                        firstLine() + 1,
                        firstLine() + shown(),
                        lines().length,
                        props.overlay.index + 1,
                        props.overlay.files.length,
                      )}${current().truncated ? strings.overlays.diff.serverTruncated : ''}`,
                      0,
                      width(),
                    ).text}
              </text>
            </box>
          );
        }}
      </Match>
      <Match when={!props.overlay.open}>
        <box
          {...title(
            strings.overlays.diff.changesTitle(
              scopeLabel(),
              diffSummary(props.overlay.files),
              props.overlay.scope === 'turn'
                ? strings.overlays.diff.session
                : strings.overlays.diff.thisTurn,
            ),
          )}
        >
          <Switch>
            <Match when={props.overlay.loading}>
              <text fg={props.theme.dim}>{strings.overlays.diff.loading}</text>
            </Match>
            <Match when={props.overlay.error}>
              {(error: Accessor<string>) => <text fg={props.theme.error}>{error()}</text>}
            </Match>
            <Match when={props.overlay.files.length === 0}>
              <text fg={props.theme.dim}>{strings.overlays.diff.empty}</text>
            </Match>
            <Match when={props.overlay.files.length > 0}>
              <For each={props.overlay.files.slice(fileRows().start, fileRows().end)}>
                {(entry, index) => {
                  const absolute = () => fileRows().start + index();
                  const selected = () => absolute() === props.overlay.index;
                  const row = () => fileRow(entry, selected());
                  return (
                    <text
                      fg={selected() ? props.theme.accent : props.theme.text}
                      onMouseUp={activate(() => props.controller.openDiffFile(absolute()))}
                    >
                      {row().mark}
                      {row().path}
                      <span style={{ fg: props.theme.success }}>{row().added}</span>
                      <span style={{ fg: props.theme.error }}>{row().removed}</span>
                    </text>
                  );
                }}
              </For>
              <text fg={props.theme.dim}>
                {fileRows().end === 0
                  ? strings.overlays.diff.noFiles
                  : sliceCells(
                      strings.overlays.diff.filesPosition(
                        fileRows().start + 1,
                        fileRows().end,
                        props.overlay.files.length,
                        props.overlay.index + 1,
                      ),
                      0,
                      width(),
                    ).text}
              </text>
            </Match>
          </Switch>
        </box>
      </Match>
    </Switch>
  );
}

/** One field at a time, with progress and the field's own controls. */
function FormDialog(props: {
  controller: AppController;
  form: FormRequest;
  editor: FormEditor;
  theme: Theme;
  frame: Frame;
}) {
  const activate = useActivate();
  const fields = () => visibleFields(props.form, props.editor.answers);
  const field = () => currentField(props.form, props.editor);
  const value = () => {
    const current = field();
    return current === undefined ? undefined : props.editor.answers[current.key];
  };
  const choices = () => {
    const current = field();
    if (current === undefined) return [];
    if (current.kind === 'choice') {
      const chosen = value();
      return current.options.map((option) => ({
        label: option.label,
        description: option.description,
        checked: typeof chosen === 'string' && chosen === option.value,
        custom: false,
      }));
    }
    if (current.kind === 'multi') {
      const raw = value();
      const chosen: readonly string[] = Array.isArray(raw) ? raw : [];
      return multiChoices(current, chosen).map((choice) => ({
        label: choice.label,
        description: choice.custom ? strings.overlays.copy.customValue : undefined,
        checked: chosen.includes(choice.value),
        custom: choice.custom,
      }));
    }
    if (current.kind === 'boolean') {
      return [
        {
          label: strings.overlays.form.yes,
          description: undefined,
          checked: false,
          custom: false,
        },
        {
          label: strings.overlays.form.no,
          description: undefined,
          checked: false,
          custom: false,
        },
      ];
    }
    return [];
  };
  const typed = () => {
    const current = field();
    return (
      current?.kind === 'text' ||
      current?.kind === 'number' ||
      (current?.kind === 'choice' && current.custom) ||
      (current?.kind === 'multi' && current.custom && props.editor.addingCustom === true)
    );
  };
  const typedComposer = () => {
    const current = field();
    return current?.kind === 'multi'
      ? { text: props.editor.customDraft ?? '', cursor: props.editor.customCursor }
      : { text: props.editor.text, cursor: props.editor.textCursor };
  };
  const choiceListFocus = () => {
    const current = field();
    return current?.kind === 'choice' && current.custom && props.editor.choiceFocus === 'list';
  };
  const paint = () => caretPaint(typedComposer(), !choiceListFocus());
  const customMulti = () => {
    const current = field();
    return current?.kind === 'multi' && current.custom ? current : undefined;
  };
  const customChoice = () => {
    const current = field();
    return current?.kind === 'choice' && current.custom ? current : undefined;
  };
  const dimensions = useTerminalDimensions();
  const choiceRows = () => Math.max(3, Math.min(12, dimensions().height - 18));
  const choiceView = () => {
    const all = choices();
    const window = choiceWindow(props.editor.cursor, all.length, choiceRows());
    return { items: all.slice(window.start, window.end), start: window.start, total: all.length };
  };
  return (
    <box {...props.frame(`${props.form.title} · ${props.editor.index + 1}/${fields().length}`)}>
      <Show when={field()}>
        {(current: Accessor<FormField>) => (
          <>
            <text fg={props.theme.text}>
              <b>{current().title}</b>
              {current().required ? <span style={{ fg: props.theme.warn }}> *</span> : ''}
            </text>
            <Show when={current().description}>
              {(description: Accessor<string>) => <text fg={props.theme.dim}>{description()}</text>}
            </Show>
            <For each={choiceView().items}>
              {(choice, index) => {
                const position = () => choiceView().start + index();
                const highlighted = () => position() === props.editor.cursor;
                const mark = () =>
                  current().kind === 'multi' ? (choice.checked ? '[x] ' : '[ ] ') : '';
                return (
                  <text
                    fg={highlighted() ? props.theme.accent : props.theme.text}
                    onMouseUp={activate(() => props.controller.clickFormChoice(position()))}
                  >
                    {
                      sliceCells(
                        `${highlighted() ? '❯' : ' '} ${mark()}${choice.label}`,
                        0,
                        Math.max(10, dimensions().width - 6),
                      ).text
                    }
                    <span style={{ fg: props.theme.dim }}>
                      {choice.description === undefined
                        ? ''
                        : `  ${sliceCells(choice.description, 0, 24).text}`}
                    </span>
                  </text>
                );
              }}
            </For>
            <Show when={choiceView().total > choiceView().items.length}>
              <text fg={props.theme.dim}>
                {strings.overlays.form.choicePosition(props.editor.cursor + 1, choiceView().total)}
              </text>
            </Show>
            <Show when={typed()}>
              <text fg={props.theme.text}>
                {'> '}
                {paint().before}
                <Show when={paint().marked !== ''}>
                  <span style={{ underline: true, fg: props.theme.accentLight }}>
                    {paint().marked}
                  </span>
                </Show>
                {paint().after}
              </text>
            </Show>
            <Show when={customChoice()}>
              <text fg={props.theme.dim}>
                {props.editor.choiceFocus === 'custom'
                  ? strings.overlays.form.customEditing
                  : props.editor.text !== ''
                    ? strings.overlays.form.customListed
                    : strings.overlays.form.customPrompt}
              </text>
            </Show>
            <Show when={current().kind === 'external' ? current() : undefined}>
              {(external: Accessor<FormField & { kind: 'external' }>) => (
                <box flexDirection="column">
                  <text fg={props.theme.text}>
                    {strings.overlays.form.externalStep(external().url)}
                  </text>
                  <box flexDirection="row">
                    <text
                      fg={props.theme.accent}
                      onMouseUp={activate(() => void props.controller.openFormExternalUrl())}
                    >
                      {strings.overlays.form.openUrl}
                    </text>
                    <text fg={props.theme.dim}>{'  '}</text>
                    <text
                      fg={props.theme.accent}
                      onMouseUp={activate(() => void props.controller.copyFormExternalUrl())}
                    >
                      {strings.overlays.form.copyUrl}
                    </text>
                  </box>
                  <text fg={props.theme.dim}>{strings.overlays.form.externalDetail}</text>
                </box>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.editor.problem}>
        {(problem: Accessor<string>) => <text fg={props.theme.error}>{problem()}</text>}
      </Show>
      <text fg={props.theme.dim}>
        {field()?.kind === 'external'
          ? strings.overlays.form.externalHints
          : strings.overlays.form.hints(customChoice() !== undefined)}
      </text>
      <Show when={customMulti()}>
        <text fg={props.theme.dim}>{strings.overlays.form.multiCustomHints}</text>
      </Show>
    </box>
  );
}

const taskMarks: Record<TaskState, string> = {
  todo: '[ ]',
  'in-progress': '[~]',
  blocked: '[!]',
  done: '[x]',
  cancelled: '[-]',
};

function TasksDialog(props: {
  controller: AppController;
  theme: Theme;
  index: number;
  frame: (title: string) => Record<string, unknown>;
}) {
  const dimensions = useTerminalDimensions();
  const taskRows = () => Math.max(3, dimensions().height - 16);
  const session = () => props.controller.tasksSession();
  const doc = () => {
    const current = session();
    return current === undefined
      ? undefined
      : props.controller.goalOf(current.id, current.serverID);
  };
  const shown = () => doc()?.proposal ?? doc()?.plan;
  const proposal = () => doc()?.proposal !== undefined;
  const title = () => {
    if (proposal()) return strings.overlays.tasks.proposedTitle;
    const count = progress(shown());
    return strings.overlays.tasks.title(count.done, count.total);
  };
  const nativeGoal = () => {
    const current = session();
    return current === undefined
      ? undefined
      : props.controller.nativeGoalStateOf(current.id, current.serverID);
  };
  const nativeGoalObject = () => {
    const known = nativeGoal();
    if (known?.status === 'verified') return known.goal;
    if (known?.status === 'unavailable') return known.last;
    return undefined;
  };
  const nativeLine = () => {
    const known = nativeGoal();
    if (known?.status === 'verified') {
      const goal = known.goal;
      if (goal.status === 'active')
        return strings.overlays.tasks.nativeActive(goal.rounds, goal.maxRounds);
      if (goal.status === 'complete')
        return strings.overlays.tasks.nativeComplete(goal.rounds, goal.maxRounds);
      return strings.overlays.tasks.nativePaused(goal.rounds, goal.maxRounds, goal.reason ?? '');
    }
    if (known?.status === 'unavailable') {
      return known.last === undefined
        ? strings.overlays.tasks.nativeUnavailable(known.reason)
        : strings.overlays.tasks.nativeLastKnown(known.last.status, known.reason);
    }
    return undefined;
  };
  const criteria = () => doc()?.criteria ?? doc()?.goal?.acceptance ?? [];
  const tasks = () => shown()?.tasks ?? [];
  const taskStart = () =>
    Math.max(0, Math.min(props.index - taskRows() + 1, tasks().length - taskRows()));
  const taskShown = () => tasks().slice(taskStart(), taskStart() + taskRows());
  return (
    <box {...props.frame(title())}>
      <Show when={nativeGoalObject() !== undefined || nativeGoal()?.status === 'unavailable'}>
        <box flexDirection="column">
          <Show when={nativeGoalObject()}>
            {(goal: Accessor<NativeGoal>) => (
              <text fg={props.theme.accentLight}>
                {strings.overlays.tasks.goal(goal().objective)}
              </text>
            )}
          </Show>
          <text fg={props.theme.dim}>{`  ${nativeLine() ?? ''}`}</text>
        </box>
      </Show>
      <Show when={doc()?.goal}>
        {(goal: Accessor<Goal>) => (
          <box flexDirection="column">
            <text fg={props.theme.accentLight}>
              {strings.overlays.tasks.localGoal(goal().title)}
            </text>
          </box>
        )}
      </Show>
      <Show
        when={tasks().length > 0}
        fallback={
          <text fg={props.theme.dim}>
            {session() === undefined
              ? strings.overlays.tasks.selectSession
              : strings.overlays.tasks.noPlan}
          </text>
        }
      >
        <For each={taskShown()}>
          {(task, index) => {
            const selected = () => taskStart() + index() === props.index;
            const label = `${selected() ? '❯' : ' '} ${taskMarks[task.state]} ${task.title}${task.evidence.length > 0 ? strings.overlays.tasks.evidence(task.evidence.length) : ''}`;
            return (
              <text
                fg={
                  selected()
                    ? props.theme.accent
                    : task.state === 'done' || task.state === 'cancelled'
                      ? props.theme.dim
                      : task.state === 'blocked'
                        ? props.theme.warn
                        : props.theme.text
                }
              >
                {sliceCells(label, 0, Math.max(10, dimensions().width - 4)).text}
              </text>
            );
          }}
        </For>
        <text fg={props.theme.dim}>
          {strings.overlays.tasks.position(props.index + 1, tasks().length)}
        </text>
      </Show>
      {/* Criteria come after the task list so a short terminal never clips the selected
          task behind a long acceptance section (#241). */}
      <Show when={criteria().length > 0}>
        <box flexDirection="column">
          <text fg={props.theme.dim}>{strings.overlays.tasks.acceptance(criteria().length)}</text>
          <For each={criteria().slice(0, 4)}>
            {(criterion) => (
              <text fg={props.theme.dim}>
                {sliceCells(`  ✓ ${criterion}`, 0, Math.max(10, dimensions().width - 4)).text}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

function queuedItems(controller: AppController) {
  // Server-qualified: a colliding session id on another host must never leak its queue.
  return controller.currentView()?.queued ?? [];
}
