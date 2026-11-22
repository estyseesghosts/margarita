import { useTerminalDimensions } from '@opentui/solid';
import type { Accessor } from 'solid-js';
import { For, Match, Show, Switch } from 'solid-js';

import type { DiffOverlay, Overlay } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { diffPageLines } from '../app/controller.ts';
import { caretPaint } from '../domain/composer.ts';
import { diffSummary, type FileDiff, type PatchLine, patchLines } from '../domain/diff.ts';
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
import { sliceCells } from '../domain/text-width.ts';
import { completenessLabel } from '../domain/transcript.ts';
import { formatCost, formatTokenCount } from '../domain/usage-format.ts';
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
  return value === undefined ? 'N/A' : `${Math.round(value)}%`;
}

/** Bounded help rows: every action plus the two global fallbacks (#241). */
function helpRows(keymap: Keymap): { label: string; detail: string }[] {
  return [
    ...actionIDs.map((action) => {
      const bindings = keymap.get(action);
      const label =
        bindings === undefined || bindings.length === 0
          ? 'unbound'
          : bindings.map(formatBinding).join(' / ');
      return { label, detail: action };
    }),
    { label: 'Left', detail: 'overview (empty prompt only)' },
    { label: 'Ctrl+C', detail: 'interrupt · clear · exit' },
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

  // One projector feeds the footer meter and this summary, so /usage and a context click
  // always show the same numbers (#124).
  const usage = () => props.controller.usageAnalytics();
  const contextLine = (): string => {
    const context = usage().context;
    if (context.status === 'pending') return 'Current context  pending after compaction…';
    if (context.status === 'unknown' || context.tokens === undefined) {
      return 'Current context  unknown (no valid assistant step with usage)';
    }
    const tokens = `Current context  ${formatTokenCount(context.tokens)}`;
    if (context.limit === undefined || context.occupancy === undefined) {
      return `${tokens} · model limit unknown`;
    }
    return `${tokens} / ${formatTokenCount(context.limit)} (${Math.round(context.occupancy)}%)`;
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
            <box {...frame('Keys · PgUp/PgDn scroll · Esc to close')}>
              <For each={shown()}>
                {(row) => (
                  <text fg={props.theme.text}>
                    {row.label.padEnd(16)}
                    <span style={{ fg: dim() }}>{row.detail}</span>
                  </text>
                )}
              </For>
              <text fg={dim()}>
                {`rows ${start() + 1}–${start() + shown().length} of ${helpRows(props.keymap).length} · PgUp/PgDn`}
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
              title={` Inspector · ${overlay().title} · Esc returns `}
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              flexGrow={1}
              flexShrink={1}
            >
              <box flexDirection="row">
                <text fg={props.theme.dim}>
                  {`${view().total.toLocaleString()} lines · showing ${shown().offset + 1}–${shown().offset + shown().lines.length}`}
                </text>
                <text
                  fg={props.theme.dim}
                >{` · source: ${completenessLabel(overlay().payload?.completeness ?? 'complete')}`}</text>
                <Show when={overlay().loading}>
                  <text fg={props.theme.accent}>{' · fetching original…'}</text>
                </Show>
              </box>
              <Show when={overlay().error}>
                {(error: Accessor<string>) => <text fg={props.theme.warn}>{`  ${error()}`}</text>}
              </Show>
              <Show
                when={overlay().searching}
                fallback={
                  <text fg={props.theme.dim}>
                    {'/ search · Enter next match · ←/→ scroll · Ctrl+Y copy · Ctrl+S save'}
                  </text>
                }
              >
                <text fg={props.theme.accent}>
                  {`/${overlay().query.slice(0, overlay().queryCursor)}▏${overlay().query.slice(overlay().queryCursor)}  · ${matchCount()} ${matchCount() === 1 ? 'match' : 'matches'} · Enter next · Esc clear/close`}
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
                  <text fg={props.theme.dim}>{'  no retained text for this result'}</text>
                </Show>
              </box>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'usage'}>
        <box {...frame('Usage · session analytics')}>
          <text fg={props.theme.text}>
            {`Session  ${usage().sessionID || 'none'} · ${usage().serverID}${usage().stale ? ' · stale' : ''}`}
          </text>
          <text fg={props.theme.text}>{contextLine()}</text>
          <Show when={usage().context.sinceCompaction !== undefined}>
            <text fg={dim()}>
              {`Since last compaction  ${formatTokenCount(usage().context.sinceCompaction ?? 0)} · compactions ${usage().completedCompactions}`}
            </text>
          </Show>
          <Show when={usage().lastCompactionAt !== undefined}>
            <text fg={dim()}>
              {`Last compaction  ${new Date(usage().lastCompactionAt ?? 0).toISOString()}`}
            </text>
          </Show>
          <text fg={props.theme.text}>{'Lifetime server totals (never reset on compaction)'}</text>
          <Show
            when={usage().lifetime}
            fallback={<text fg={dim()}>Token totals not reported.</text>}
          >
            {(tokens: Accessor<TokenUsage>) => (
              <>
                <text fg={dim()}>
                  {`  input ${formatTokenCount(tokens().input)} · output ${formatTokenCount(tokens().output)} · reasoning ${formatTokenCount(tokens().reasoning)}`}
                </text>
                <text fg={dim()}>
                  {`  cache read ${formatTokenCount(tokens().cacheRead)} · cache write ${formatTokenCount(tokens().cacheWrite)}`}
                </text>
              </>
            )}
          </Show>
          <text fg={props.theme.text}>
            {`Session spend  ${usage().cost === undefined ? 'not reported' : formatCost(usage().cost)} · server-reported, not an invoice`}
          </text>
          <text fg={props.theme.text}>{'Activity · loaded messages only'}</text>
          <text fg={dim()}>
            {`  tool turns ${usage().toolUsingTurns}/${usage().completedUserTurns} (${analyticsPercent(usage().toolTurnPercent)} of user turns) · tool calls ${usage().toolCalls}`}
          </text>
          <text fg={dim()}>
            {`  read ${usage().toolCategories.read} · search ${usage().toolCategories.search} · edit ${usage().toolCategories.edit} · shell ${usage().toolCategories.shell} · code ${usage().toolCategories.code} · web ${usage().toolCategories.web} · delegate ${usage().toolCategories.delegate} · MCP ${usage().toolCategories.mcp} · other ${usage().toolCategories.other}`}
          </text>
          <text fg={dim()}>
            {`  completed ${usage().toolCompleted} · failed ${usage().toolFailed} · running ${usage().toolRunning} · other ${usage().toolOther} · failure ${analyticsPercent(usage().toolFailurePercent)} of known outcomes`}
          </text>
          <text fg={dim()}>
            {'Tool stats cover loaded messages only; context uses the step model limit.'}
          </text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'status'}>
        <box {...frame('Status')}>
          <text fg={props.theme.text}>{`Server  ${props.controller.serverUrl}`}</text>
          <text fg={props.theme.text}>{`Stream  ${state.stream}`}</text>
          <text fg={props.theme.text}>{`Project ${props.controller.currentDirectory()}`}</text>
          <Show when={props.controller.currentSession()}>
            {(session: Accessor<SessionSummary>) => (
              <text fg={props.theme.text}>{`Session ${session().id}`}</text>
            )}
          </Show>
          <text fg={dim()}>{`margarita v${props.controller.version}`}</text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'servers'}>
        <box {...frame('Servers · /servers rename <old> <new> · /unpair <name> · Esc close')}>
          <For each={props.controller.serverList()}>
            {(server) => (
              <text fg={server.active ? props.theme.accent : props.theme.text}>
                {`${server.active ? '❯' : ' '} ${server.label}  ${server.baseUrl}  [${server.state}]`}
              </text>
            )}
          </For>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'unpair-confirm' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'unpair-confirm' }>>) => (
          <box {...frame('Unpair · Enter confirm · Esc cancel')}>
            <text fg={props.theme.text}>
              {`Remove local access to "${overlay().label}" and its saved credentials?`}
            </text>
            <text fg={dim()}>
              Remote sessions keep running. Removing local credentials does not revoke an
              already-issued server token.
            </text>
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
            <box {...frame('Queue · ↑↓ PgUp/PgDn · x cancel · s steer · Esc close')}>
              <Show
                when={queuedItems(props.controller).length > 0}
                fallback={<text fg={dim()}>Nothing queued.</text>}
              >
                <For each={shown()}>
                  {(item, index) => {
                    const position = () => start() + index();
                    const label = `${position() === overlay().index ? '❯' : ' '} [${item.delivery}] ${sanitizeTerminalText(item.text.split('\n')[0] ?? '')}`;
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
                  {`${overlay().index + 1} of ${queuedItems(props.controller).length} · PgUp/PgDn move ten`}
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
                  ? 'Model · type to filter · Enter select'
                  : 'Model for new sessions · type to filter · Enter select',
              )}
            >
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>No matching models.</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(choice, index) => {
                    const absolute = () => view().start + index();
                    const selected = () => absolute() === overlay().index;
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseDown={() => {
                          props.controller.selectModelPickerIndex(absolute());
                          void props.controller.acceptModelPicker();
                        }}
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
                  {`${overlay().index + 1} of ${choices().length} · type to filter`}
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
            <box {...frame('Effort · type to filter · Enter select · Esc cancel')}>
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>No variants available for this model.</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(choice, index) => {
                    const absolute = () => view().start + index();
                    const selected = () => absolute() === overlay().index;
                    const active = () => choice.variant === current();
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseDown={() => {
                          props.controller.selectEffortPickerIndex(absolute());
                          void props.controller.acceptEffortPicker();
                        }}
                      >
                        {
                          sliceCells(
                            `${selected() ? '❯' : ' '} ${choice.label}${active() ? ' (current)' : ''}`,
                            0,
                            Math.max(10, terminal().width - 6),
                          ).text
                        }
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {`${overlay().index + 1} of ${choices().length} · type to filter`}
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
                  ? 'Agent · type to filter · Enter select'
                  : 'Agent for new sessions · type to filter · Enter select',
              )}
            >
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>No matching agents.</text>}
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(agent, index) => {
                    const absolute = () => view().start + index();
                    const selected = () => absolute() === overlay().index;
                    const active = () => agent.id === current();
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseDown={() => {
                          props.controller.selectAgentPickerIndex(absolute());
                          void props.controller.acceptAgentPicker();
                        }}
                      >
                        {
                          sliceCells(
                            `${selected() ? '❯' : ' '} ${agent.id}  ${active() ? '(current) ' : ''}${agent.description ?? ''}`,
                            0,
                            Math.max(10, terminal().width - 6),
                          ).text
                        }
                      </text>
                    );
                  }}
                </For>
                <text fg={dim()}>
                  {`${overlay().index + 1} of ${choices().length} · type to filter`}
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
            <box {...frame('Copy exact text · type to filter · Enter copy')}>
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={
                  <text fg={dim()}>No tool output, diff or code block in this session.</text>
                }
              >
                <For each={choices().slice(view().start, view().end)}>
                  {(item, index) => {
                    const selected = () => view().start + index() === overlay().index;
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseDown={() => {
                          props.controller.selectCopyPickerIndex(view().start + index());
                          void props.controller.acceptCopyPicker();
                        }}
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
                  {`${overlay().index + 1} of ${choices().length} · type to filter`}
                </text>
              </Show>
              <text fg={dim()}>Unretained or server-truncated payloads are labelled above.</text>
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
            <box {...frame('Rewind · ↑↓ prompt · Enter stage · Esc cancel')}>
              <text fg={props.theme.text}>
                {`Earlier prompt to revert file changes to (${choices().length} in loaded history) · ${overlay().index + 1} of ${choices().length}:`}
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
                {`Scope: files changed after prompt #${choices()[overlay().index]?.ordinal ?? '?'} · ${overlay().loading ? 'reading…' : overlay().previewUnavailable ? 'file scope unavailable' : diffSummary(overlay().files)}`}
              </text>
              <For each={overlay().files.slice(0, 4)}>
                {(file) => (
                  <text fg={dim()}>{`  ${file.file}  +${file.additions} −${file.deletions}`}</text>
                )}
              </For>
              <text fg={dim()}>
                Files only — the conversation is not rewritten; the server offers no redo.
              </text>
              <text fg={dim()}>Prompt times are shown in UTC.</text>
              <text fg={dim()}>Enter stages the boundary; a separate confirmation applies it.</text>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'revert' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'revert' }>>) => (
          <box {...frame('Revert · Enter confirm · Esc restore files')}>
            <text fg={props.theme.text}>
              {`Undo changes since your last message: ${diffSummary(overlay().files)}`}
            </text>
            <For each={overlay().files.slice(0, pickerRows())}>
              {(file) => (
                <text fg={dim()}>{`  ${file.file}  +${file.additions} −${file.deletions}`}</text>
              )}
            </For>
            <Show when={overlay().busy}>
              <text fg={dim()}>Working…</text>
            </Show>
          </box>
        )}
      </Match>
      <Match when={state.overlay.kind === 'diff' ? state.overlay : undefined}>
        {(overlay: Accessor<DiffOverlay>) => (
          <DiffDialog overlay={overlay()} theme={props.theme} frame={frame} />
        )}
      </Match>
      <Match when={state.overlay.kind === 'form' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'form' }>>) => (
          <Show
            when={props.controller.openFormRequest()}
            fallback={<text fg={dim()}>This question was answered or withdrawn.</text>}
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
              `History search · ${actionHint(props.keymap, 'history.search') ?? ''} older · Enter use`,
            )}
          >
            <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
            <text fg={dim()}>{props.controller.historySearchMatch() ?? 'no match'}</text>
          </box>
        )}
      </Match>
    </Switch>
  );
}

type Frame = (title: string) => Record<string, unknown>;

const statusMark = { added: 'A', deleted: 'D', modified: 'M' } as const;

/** File list, or one file's colored patch; everything comes from `session.diff`. */
function DiffDialog(props: { overlay: DiffOverlay; theme: Theme; frame: Frame }) {
  const file = () => props.overlay.files[props.overlay.index];
  const scopeLabel = () => (props.overlay.scope === 'turn' ? 'this turn' : 'session');
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
  return (
    <Switch>
      <Match when={props.overlay.open ? file() : undefined}>
        {(current: Accessor<FileDiff>) => {
          const lines = () => patchLines(current().patch);
          return (
            <box {...props.frame(`${current().file} · ↑↓ PgUp PgDn scroll · ← files`)}>
              <For each={lines().slice(props.overlay.offset, props.overlay.offset + diffPageLines)}>
                {(line) => (
                  <text fg={lineColor(line.kind)}>{line.text === '' ? ' ' : line.text}</text>
                )}
              </For>
              <text fg={props.theme.dim}>
                {`lines ${Math.min(props.overlay.offset + 1, lines().length)}–${Math.min(props.overlay.offset + diffPageLines, lines().length)} of ${lines().length}${current().truncated ? ' · truncated by server' : ''}`}
              </text>
            </box>
          );
        }}
      </Match>
      <Match when={!props.overlay.open}>
        <box
          {...props.frame(
            `Changes in ${scopeLabel()} · ${diffSummary(props.overlay.files)} · t ${props.overlay.scope === 'turn' ? 'session' : 'turn'} · Esc close`,
          )}
        >
          <Switch>
            <Match when={props.overlay.loading}>
              <text fg={props.theme.dim}>Loading changes…</text>
            </Match>
            <Match when={props.overlay.error}>
              {(error: Accessor<string>) => <text fg={props.theme.error}>{error()}</text>}
            </Match>
            <Match when={props.overlay.files.length === 0}>
              <text fg={props.theme.dim}>No file changes reported.</text>
            </Match>
            <Match when={props.overlay.files.length > 0}>
              <For each={props.overlay.files}>
                {(entry, index) => {
                  const selected = () => index() === props.overlay.index;
                  return (
                    <text fg={selected() ? props.theme.accent : props.theme.text}>
                      {`${selected() ? '❯' : ' '} ${statusMark[entry.status]} ${entry.file}`}
                      <span style={{ fg: props.theme.success }}>{`  +${entry.additions}`}</span>
                      <span style={{ fg: props.theme.error }}>{` −${entry.deletions}`}</span>
                    </text>
                  );
                }}
              </For>
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
        description: choice.custom ? 'custom value' : undefined,
        checked: chosen.includes(choice.value),
        custom: choice.custom,
      }));
    }
    if (current.kind === 'boolean') {
      return [
        { label: 'Yes', description: undefined, checked: false, custom: false },
        { label: 'No', description: undefined, checked: false, custom: false },
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
                    onMouseDown={() => props.controller.clickFormChoice(position())}
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
                {`choice ${props.editor.cursor + 1} of ${choiceView().total} · ↑↓ PgUp/PgDn Home/End`}
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
                  ? 'editing custom value · Enter submits it · ↑↓ return to listed options'
                  : props.editor.text !== ''
                    ? 'listed option will be submitted · Ctrl+E edit saved custom draft'
                    : '↑↓ choose a listed option · type or Ctrl+E for a custom value'}
              </text>
            </Show>
            <Show when={current().kind === 'external' ? current() : undefined}>
              {(external: Accessor<FormField & { kind: 'external' }>) => (
                <box flexDirection="column">
                  <text fg={props.theme.text}>{`External step: ${external().url}`}</text>
                  <box flexDirection="row">
                    <text
                      fg={props.theme.accent}
                      onMouseDown={() => void props.controller.openFormExternalUrl()}
                    >
                      {'[ Open URL ]'}
                    </text>
                    <text fg={props.theme.dim}>{'  '}</text>
                    <text
                      fg={props.theme.accent}
                      onMouseDown={() => void props.controller.copyFormExternalUrl()}
                    >
                      {'[ Copy URL ]'}
                    </text>
                  </box>
                  <text fg={props.theme.dim}>
                    Opening or copying is not an answer; keep this pending until the server
                    completes it.
                  </text>
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
          ? 'o open · c copy · Enter next · Shift+Tab back · Esc later · Ctrl+X decline'
          : `Enter next · Shift+Tab back · ↑↓ choose${customChoice() ? ' · Ctrl+E custom' : ''} · Space toggle · Esc later · Ctrl+X decline`}
      </text>
      <Show when={customMulti()}>
        <text fg={props.theme.dim}>a add custom value · x remove selected custom value</text>
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
    if (proposal()) return 'Proposed plan · a accept · r reject · Esc close';
    const count = progress(shown());
    return `Tasks ${count.done}/${count.total} · Space state · b blocked · x cancel · e evidence`;
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
      const round = `round ${goal.rounds}/${goal.maxRounds}`;
      if (goal.status === 'active') return `◎ active · ${round}`;
      if (goal.status === 'complete') return `● complete · ${round}`;
      return `◌ paused · ${round}${goal.reason === undefined ? '' : ` · ${goal.reason}`}`;
    }
    if (known?.status === 'unavailable') {
      return known.last === undefined
        ? `status unavailable (${known.reason}) · not a confirmed absence`
        : `last known: ${known.last.status} · stale (${known.reason})`;
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
              <text fg={props.theme.accentLight}>{`Goal: ${goal().objective}`}</text>
            )}
          </Show>
          <text fg={props.theme.dim}>{`  ${nativeLine() ?? ''}`}</text>
        </box>
      </Show>
      <Show when={doc()?.goal}>
        {(goal: Accessor<Goal>) => (
          <box flexDirection="column">
            <text fg={props.theme.accentLight}>{`Local goal: ${goal().title}`}</text>
          </box>
        )}
      </Show>
      <Show
        when={tasks().length > 0}
        fallback={
          <text fg={props.theme.dim}>
            {session() === undefined
              ? 'Select a session to view its tasks.'
              : 'No plan. /plan step one; step two · or /plan propose'}
          </text>
        }
      >
        <For each={taskShown()}>
          {(task, index) => {
            const selected = () => taskStart() + index() === props.index;
            const label = `${selected() ? '❯' : ' '} ${taskMarks[task.state]} ${task.title}${task.evidence.length > 0 ? ` · ${task.evidence.length} evidence` : ''}`;
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
        <text fg={props.theme.dim}>{`${props.index + 1} of ${tasks().length} · ↑↓ PgUp/PgDn`}</text>
      </Show>
      {/* Criteria come after the task list so a short terminal never clips the selected
          task behind a long acceptance section (#241). */}
      <Show when={criteria().length > 0}>
        <box flexDirection="column">
          <text fg={props.theme.dim}>
            {`Acceptance${criteria().length > 4 ? ` (${criteria().length}, first 4 shown)` : ''}:`}
          </text>
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
