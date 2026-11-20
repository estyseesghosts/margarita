import type { Accessor } from 'solid-js';
import { For, Match, Show, Switch } from 'solid-js';

import type { DiffOverlay, Overlay } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { diffPageLines } from '../app/controller.ts';
import { diffSummary, type FileDiff, type PatchLine, patchLines } from '../domain/diff.ts';
import {
  currentField,
  type FormEditor,
  type FormField,
  type FormRequest,
  visibleFields,
} from '../domain/form.ts';
import { type Goal, progress, type TaskState } from '../domain/goal-plan.ts';
import { actionHint, actionIDs, formatBinding, type Keymap } from '../domain/keymap.ts';
import { formatModelRef } from '../domain/model-ref.ts';
import type { NativeGoal } from '../domain/native-goal.ts';
import { rewindTimeLabel } from '../domain/rewind.ts';
import type { SessionSummary, TokenUsage } from '../domain/session.ts';
import { localCommands } from '../domain/slash-command.ts';
import { formatCost, formatTokenCount } from '../domain/usage-format.ts';
import type { Theme } from './theme.ts';

const visibleRows = 10;

/** Focused dialogs drawn above the composer. They are overlays, never routes. */
export function OverlayView(props: { controller: AppController; keymap: Keymap; theme: Theme }) {
  const state = props.controller.state;
  const frame = (title: string) => ({
    border: true,
    borderStyle: 'rounded' as const,
    borderColor: props.theme.border,
    title: ` ${title} `,
    flexDirection: 'column' as const,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  const dim = () => props.theme.dim;

  return (
    <Switch>
      <Match when={state.overlay.kind === 'help'}>
        <box {...frame('Keys · Esc to close')}>
          <For each={actionIDs}>
            {(action) => {
              const bindings = props.keymap.get(action);
              const label =
                bindings === undefined || bindings.length === 0
                  ? 'unbound'
                  : bindings.map(formatBinding).join(' / ');
              return (
                <text fg={props.theme.text}>
                  {label.padEnd(16)}
                  <span style={{ fg: dim() }}>{action}</span>
                </text>
              );
            }}
          </For>
          <text fg={props.theme.text}>
            {'Left'.padEnd(16)}
            <span style={{ fg: dim() }}>overview (empty prompt only)</span>
          </text>
          <text fg={props.theme.text}>
            {'Ctrl+C'.padEnd(16)}
            <span style={{ fg: dim() }}>interrupt · clear · exit</span>
          </text>
          <text fg={dim()} marginTop={1}>
            {Object.keys(localCommands)
              .map((name) => `/${name}`)
              .join(' ')}
          </text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'usage'}>
        <box {...frame('Usage · server-reported')}>
          <Show
            when={props.controller.currentSession()}
            fallback={<text fg={dim()}>Open a session to see its usage.</text>}
          >
            {(session: Accessor<SessionSummary>) => (
              <>
                <text fg={props.theme.text}>{`Session spend  ${formatCost(session().cost)}`}</text>
                <Show
                  when={session().tokens}
                  fallback={<text fg={dim()}>Token usage not reported.</text>}
                >
                  {(tokens: Accessor<TokenUsage>) => (
                    <>
                      <text
                        fg={props.theme.text}
                      >{`Input          ${formatTokenCount(tokens().input)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Output         ${formatTokenCount(tokens().output)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Reasoning      ${formatTokenCount(tokens().reasoning)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Cache read     ${formatTokenCount(tokens().cacheRead)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Cache write    ${formatTokenCount(tokens().cacheWrite)}`}</text>
                    </>
                  )}
                </Show>
                <text
                  fg={dim()}
                >{`Model  ${props.controller.describeModel(session().model)}`}</text>
              </>
            )}
          </Show>
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
          return (
            <box {...frame('Queue · ↑↓ select · x cancel · s steer · Esc close')}>
              <Show
                when={queuedItems(props.controller).length > 0}
                fallback={<text fg={dim()}>Nothing queued.</text>}
              >
                <For each={queuedItems(props.controller)}>
                  {(item, index) => (
                    <text fg={index() === overlay().index ? props.theme.accent : props.theme.text}>
                      {`${index() === overlay().index ? '❯' : ' '} [${item.delivery}] ${item.text.split('\n')[0] ?? ''}`}
                    </text>
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'model-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'model-picker' }>>) => {
          const choices = () => props.controller.modelChoices(overlay().query);
          const start = () => Math.max(0, overlay().index - visibleRows + 1);
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
                <For each={choices().slice(start(), start() + visibleRows)}>
                  {(choice, index) => {
                    const selected = () => start() + index() === overlay().index;
                    return (
                      <text fg={selected() ? props.theme.accent : props.theme.text}>
                        {`${selected() ? '❯' : ' '} ${formatModelRef(choice)}`}
                      </text>
                    );
                  }}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'agent-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'agent-picker' }>>) => {
          const choices = () => props.controller.agentChoices(overlay().query);
          const start = () => Math.max(0, overlay().index - visibleRows + 1);
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
                <For each={choices().slice(start(), start() + visibleRows)}>
                  {(agent, index) => {
                    const absolute = () => start() + index();
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
                        {`${selected() ? '❯' : ' '} ${agent.id}`}
                        <span style={{ fg: dim() }}>
                          {`  ${active() ? '(current) ' : ''}${agent.description ?? ''}`}
                        </span>
                      </text>
                    );
                  }}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'copy-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'copy-picker' }>>) => {
          const choices = () => props.controller.copyChoices(overlay().query);
          const start = () => Math.max(0, overlay().index - visibleRows + 1);
          return (
            <box {...frame('Copy exact text · type to filter · Enter copy')}>
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={
                  <text fg={dim()}>No tool output, diff or code block in this session.</text>
                }
              >
                <For each={choices().slice(start(), start() + visibleRows)}>
                  {(item, index) => {
                    const selected = () => start() + index() === overlay().index;
                    return (
                      <text
                        fg={selected() ? props.theme.accent : props.theme.text}
                        onMouseDown={() => {
                          props.controller.selectCopyPickerIndex(start() + index());
                          void props.controller.acceptCopyPicker();
                        }}
                      >
                        {`${selected() ? '❯' : ' '} ${item.label}`}
                      </text>
                    );
                  }}
                </For>
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
          const start = () => Math.max(0, overlay().index - visibleRows + 1);
          return (
            <box {...frame('Rewind · ↑↓ prompt · Enter stage · Esc cancel')}>
              <text fg={props.theme.text}>
                {`Earlier prompt to revert file changes to (${choices().length} in loaded history):`}
              </text>
              <For each={choices().slice(start(), start() + visibleRows)}>
                {(choice, index) => {
                  const position = () => start() + index();
                  const selected = () => position() === overlay().index;
                  return (
                    <text fg={selected() ? props.theme.accent : props.theme.text}>
                      {`${selected() ? '❯' : ' '} ${choice.ordinal}. ${rewindTimeLabel(choice.createdAt)}  ${choice.text}`}
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
            <For each={overlay().files.slice(0, visibleRows)}>
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
function FormDialog(props: { form: FormRequest; editor: FormEditor; theme: Theme; frame: Frame }) {
  const fields = () => visibleFields(props.form, props.editor.answers);
  const field = () => currentField(props.form, props.editor);
  const value = () => {
    const current = field();
    return current === undefined ? undefined : props.editor.answers[current.key];
  };
  const choices = () => {
    const current = field();
    if (current === undefined) return [];
    if (current.kind === 'choice' || current.kind === 'multi') {
      const chosen = value();
      return current.options.map((option) => ({
        label: option.label,
        description: option.description,
        checked: current.kind === 'multi' && Array.isArray(chosen) && chosen.includes(option.value),
      }));
    }
    if (current.kind === 'boolean') {
      return [
        { label: 'Yes', description: undefined, checked: false },
        { label: 'No', description: undefined, checked: false },
      ];
    }
    return [];
  };
  const typed = () => {
    const current = field();
    return (
      current?.kind === 'text' ||
      current?.kind === 'number' ||
      (current?.kind === 'choice' && current.custom)
    );
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
            <For each={choices()}>
              {(choice, index) => {
                const highlighted = () => index() === props.editor.cursor;
                const mark = () =>
                  current().kind === 'multi' ? (choice.checked ? '[x] ' : '[ ] ') : '';
                return (
                  <text fg={highlighted() ? props.theme.accent : props.theme.text}>
                    {`${highlighted() ? '❯' : ' '} ${mark()}${choice.label}`}
                    <span style={{ fg: props.theme.dim }}>
                      {choice.description === undefined ? '' : `  ${choice.description}`}
                    </span>
                  </text>
                );
              }}
            </For>
            <Show when={typed()}>
              <text fg={props.theme.text}>{`> ${props.editor.text}`}</text>
            </Show>
            <Show when={current().kind === 'external' ? current() : undefined}>
              {(external: Accessor<FormField & { kind: 'external' }>) => (
                <text fg={props.theme.accent}>{`Open in a browser: ${external().url}`}</text>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.editor.problem}>
        {(problem: Accessor<string>) => <text fg={props.theme.error}>{problem()}</text>}
      </Show>
      <text fg={props.theme.dim}>
        Enter next · Shift+Tab back · ↑↓ choose · Space toggle · Esc later · Ctrl+X decline
      </text>
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
      <Show when={criteria().length > 0}>
        <box flexDirection="column">
          <text fg={props.theme.dim}>Acceptance:</text>
          <For each={criteria()}>
            {(criterion) => <text fg={props.theme.dim}>{`  ✓ ${criterion}`}</text>}
          </For>
        </box>
      </Show>
      <Show
        when={(shown()?.tasks.length ?? 0) > 0}
        fallback={
          <text fg={props.theme.dim}>
            {session() === undefined
              ? 'Select a session to view its tasks.'
              : 'No plan. /plan step one; step two · or /plan propose'}
          </text>
        }
      >
        <For each={shown()?.tasks ?? []}>
          {(task, index) => {
            const selected = () => index() === props.index;
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
                {`${selected() ? '❯' : ' '} ${taskMarks[task.state]} ${task.title}${task.evidence.length > 0 ? ` · ${task.evidence.length} evidence` : ''}`}
              </text>
            );
          }}
        </For>
      </Show>
    </box>
  );
}

function queuedItems(controller: AppController) {
  // Server-qualified: a colliding session id on another host must never leak its queue.
  return controller.currentView()?.queued ?? [];
}
