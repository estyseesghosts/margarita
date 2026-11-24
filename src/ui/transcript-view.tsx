import type { ScrollBoxRenderable, SyntaxStyle } from '@opentui/core';
import { getTreeSitterClient } from '@opentui/core';
import { useRenderer } from '@opentui/solid';
import type { Accessor } from 'solid-js';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from 'solid-js';

import type { PermissionPrompt } from '../adapter/backend.ts';
import type { JobListStatus } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import type { ScrollMove } from '../app/key-router.ts';
import type { PatchLine } from '../domain/diff.ts';
import {
  clampDiffPatch,
  diffCounts,
  editDiff,
  hasOversizedDiff,
  isEditLike,
  toolPath,
} from '../domain/edit-diff.ts';
import { type ExecutionMarker } from '../domain/execution-segment.ts';
import { type FormRequest, initialVisibleFields } from '../domain/form.ts';
import { actionHint, type Keymap } from '../domain/keymap.ts';
import { formatModelRef, type ModelSelection } from '../domain/model-ref.ts';
import {
  sanitizeSingleLine,
  sanitizeTerminalText as sanitizeText,
} from '../domain/sanitize-text.ts';
import { sessionKey } from '../domain/server-identity.ts';
import { assertNever } from '../domain/session.ts';
import type { ShellBackgroundState } from '../domain/shell-job.ts';
import { followsLiveTail, stickyPrompt, truncatePrompt } from '../domain/sticky-prompt.ts';
import { clipLineToCells } from '../domain/text-width.ts';
import { type ThrobberFacts } from '../domain/throbber.ts';
import { pagedToolChildren, toolChildBudget, type ToolChildPage } from '../domain/tool-children.ts';
import {
  activeTool,
  attachBackgroundNotices,
  backgroundHint,
  boundedPreview,
  boundedTailPreview,
  describeTool,
  formatToolTiming,
  type LiveTool,
  nodeViewFromArray,
  previewBudget,
  type PreviewKind,
  type ProjectionStats,
  semanticPreview,
  type ToolCall,
  type ToolCallChild,
  toolFileLabel,
  toolFileWindow,
  toolIdentity,
  toolMetadataRowBudget,
  type TranscriptNode,
  type TranscriptNodeView,
  windowNodeView,
} from '../domain/transcript.ts';
import { type WorkerStatus, workerStatusLabel } from '../domain/worker.ts';
import { countFormat } from '../perf/format-counts.ts';
import { markerText } from './marker-text.ts';
import { useActivate } from './pointer.ts';
import { QueuedPreview } from './queued-preview.tsx';
import { createSyntaxStyle } from './syntax.ts';
import type { Theme } from './theme.ts';
import { Throbber } from './throbber-view.tsx';

export type TranscriptProps = Readonly<{
  controller: AppController;
  keymap: Keymap;
  sessionID: string;
  serverID: string;
  theme: Theme;
  width: number;
  animate: boolean;
  ascii: boolean;
  /** How often the 10s background hint threshold is re-checked (default 1s). */
  hintTickMs?: number | undefined;
  /** Receives the scroll function for key routing while this transcript is mounted. */
  onScrollHandle?: (scroll: ((move: ScrollMove) => void) | undefined) => void;
  /**
   * Benchmark-only observation hook. Production leaves it undefined; keeping it optional
   * means the projector does no extra work unless a caller explicitly asks for counters.
   */
  onProjectionStats?: ((stats: ProjectionStats) => void) | undefined;
}>;

type NodeOf<K extends TranscriptNode['kind']> = Extract<TranscriptNode, { kind: K }>;

/** One bounded warning for rows retained after a failed job refresh (#230). */
function jobWarning(
  worker: JobListStatus | undefined,
  shell: JobListStatus | undefined,
): string | undefined {
  const failed = [worker, shell].filter(
    (status): status is JobListStatus => status !== undefined && status.state !== 'confirmed',
  );
  if (failed.length === 0) return undefined;
  const retained = failed.some((status) => status.state === 'stale');
  const detail = failed.find((status) => status.detail !== undefined)?.detail ?? 'refresh failed';
  return retained
    ? `  background jobs may be out of date · ${detail}`
    : `  background job state unavailable · ${detail}`;
}

export function Transcript(props: TranscriptProps) {
  const state = props.controller.state;
  const backgroundKey = actionHint(props.keymap, 'tools.background');
  const sessionKeyValue = () =>
    sessionKey({ serverID: props.serverID, sessionID: props.sessionID });
  // The hint threshold is 10s, so a 2s tick keeps it accurate without transcript-speed
  // redraws, and the timer only asks while a call is actually running.
  const [hintNow, setHintNow] = createSignal(props.controller.now());
  const hintTimer = setInterval(() => {
    if (state.running[sessionKeyValue()] !== true) return;
    setHintNow(props.controller.now());
  }, props.hintTickMs ?? 1000);
  onCleanup(() => clearInterval(hintTimer));
  const transcript = () => state.transcripts[sessionKeyValue()];
  const mcpServers = () =>
    props.controller.mcpServersFor(
      props.serverID,
      state.sessions[sessionKeyValue()]?.directory ?? '',
    );
  // The controller owns one authoritative projection per transcript (#353); the view only
  // attaches transient client-local notices and renders the visible tail.
  const base = createMemo(() => {
    const view = props.controller.presentationFor(props.sessionID, props.serverID);
    const stats = props.controller.presentationStatsOf(props.sessionID, props.serverID);
    if (stats !== undefined) props.onProjectionStats?.(stats);
    return view;
  });
  const nodes = createMemo((): TranscriptNodeView => {
    const folded = base();
    // A background confirmation is a transcript event, not a footer notice: inserting it
    // here keeps the composer anchored (#129). It is attached to the *exact* owning tool node
    // by tool ID, never to "the last tool-looking node": a later appended call cannot inherit
    // it, and a call outside this window simply shows no notice instead of a wrong one (#135).
    const background = state.backgrounded[sessionKeyValue()] ?? [];
    const withBackground =
      background.length > 0 && state.running[sessionKeyValue()] === true
        ? nodeViewFromArray(attachBackgroundNotices(folded.toArray(), background))
        : folded;
    // A failed worker/shell refresh keeps the last confirmed rows and adds one bounded stale
    // warning. The rows themselves are already part of the controller projection (#101, #230).
    const key = sessionKeyValue();
    const warning = jobWarning(state.workerStatus[key], state.shellStatus[key]);
    return withBackground.append(
      warning === undefined
        ? []
        : [{ kind: 'meta' as const, key: `job-status:${key}`, text: warning }],
    );
  });
  const windowed = createMemo(() =>
    windowNodeView(nodes(), props.controller.transcriptWindow(props.sessionID, props.serverID)),
  );
  // Server-confirmed pending user follow-ups, FIFO (server order) — rendered in the
  // activity region right above the running task marker, never inside the composer.
  const queued = createMemo(() =>
    (state.inbox[sessionKeyValue()] ?? []).filter((item) => item.kind === 'user'),
  );
  const hasRunningMarker = createMemo(() =>
    nodes().some((node) => node.kind === 'execution' && node.segment.phase === 'running'),
  );
  let box: ScrollBoxRenderable | undefined;
  const renderer = useRenderer();
  const syntax = createMemo(() => createSyntaxStyle(props.theme, renderer.nativeScene));
  const [sticky, setSticky] = createSignal<string | undefined>(undefined);
  /**
   * A semantic pagination anchor: the node key and its viewport offset before history was
   * prepended. `<Index>` reuses row slots, so anchoring a renderable is not stable when a
   * prepend changes which node occupies each slot (#243). The key is restored after layout.
   */
  const [pendingAnchor, setPendingAnchor] = createSignal<
    { key: string; offset: number } | undefined
  >(undefined);
  const nodeIndexFor = () =>
    new Map(
      nodes()
        .toArray()
        .map((node, index) => [node.key, index] as const),
    );

  /**
   * Recomputes which earlier prompt, if any, has scrolled out above the viewport. The
   * sticky strip is reading chrome for history only: while the box follows the live tail
   * (within the documented row tolerance) it disappears even if a long current turn has
   * pushed its prompt above the viewport (#280).
   */
  const updateSticky = () => {
    if (box === undefined) return;
    const scrollbox = box;
    if (followsLiveTail(scrollbox.scrollTop, scrollbox.scrollHeight, scrollbox.height)) {
      setSticky(undefined);
      return;
    }
    const positions = windowed().visible.flatMap((node) => {
      if (node.kind !== 'user') return [];
      const element = scrollbox.findDescendantById(nodeID(node.key));
      if (element === undefined) return [];
      // The wrapper starts with the prompt's top margin row.
      const top = element.y + 1 - scrollbox.y;
      return [
        { key: node.key, text: node.text, top, bottom: top + Math.max(1, element.height - 1) },
      ];
    });
    const found = stickyPrompt(positions);
    if (found !== undefined) {
      setSticky(found.text);
      return;
    }
    // The user prompt may be older than every user node in the render window (#244).
    // Resolve the latest preceding prompt from the full folded conversation, not only the
    // mounted window, then require that the resolved node is actually above the viewport.
    const top = windowed().visible.find((node) => {
      const element = scrollbox.findDescendantById(nodeID(node.key));
      return element !== undefined && element.y + element.height > scrollbox.y;
    });
    const index = top === undefined ? undefined : nodeIndexFor().get(top.key);
    if (index !== undefined) {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const node = nodes().at(cursor);
        if (node?.kind === 'user') {
          setSticky(node.text);
          return;
        }
      }
    }
    setSticky(undefined);
  };
  createEffect(() => {
    windowed();
    box?.afterLayout(updateSticky);
  });

  // A route/host switch must never carry the previous conversation's pinned prompt.
  createEffect(() => {
    // Track owner identity; the values themselves are read through props elsewhere.
    void props.sessionID;
    void props.serverID;
    setSticky(undefined);
    box?.afterLayout(updateSticky);
  });

  /**
   * Restores the semantic anchor after every layout while an older page is in flight.
   * A fixed timeout cannot cover a slow history response (#243). The anchor is released
   * once loading settles and the target has been positioned.
   */
  createEffect(() => {
    const anchor = pendingAnchor();
    const loading = transcript()?.loading === true;
    // Read the window so a prepended page schedules another restoration.
    windowed();
    if (anchor === undefined || box === undefined) return;
    const scrollbox = box;
    scrollbox.afterLayout(() => {
      const target = scrollbox.findDescendantById(nodeID(anchor.key));
      if (target === undefined) {
        if (!loading) setPendingAnchor(undefined);
        return;
      }
      const offset = target.y - scrollbox.y;
      if (offset !== anchor.offset) scrollbox.scrollBy(offset - anchor.offset);
      if (!loading) setPendingAnchor(undefined);
    });
  });

  // Ctrl+↑/↓ focuses an item even when it is outside the render window. Reveal it first,
  // then scroll the semantic row into view after layout (#242). Only a focus change may
  // move the viewport; streaming updates keep the reader's own scroll anchor.
  let scrolledFocus: string | undefined;
  let focusRevealToken = 0;
  createEffect(() => {
    const focused = state.focusedGroup;
    windowed();
    if (focused === undefined || box === undefined) {
      scrolledFocus = undefined;
      focusRevealToken += 1;
      return;
    }
    if (scrolledFocus === focused) return;
    scrolledFocus = focused;
    const key = focusedNodeKey(focused);
    untrack(() => {
      props.controller.ensureTranscriptNodeVisible(props.sessionID, key, props.serverID);
    });
    const scrollbox = box;
    const token = ++focusRevealToken;
    scrollbox.afterLayout(() => {
      // A delayed callback belongs to the focus that queued it (#296).
      if (token !== focusRevealToken) return;
      if (state.focusedGroup === undefined || focusedNodeKey(state.focusedGroup) !== key) {
        return;
      }
      scrollbox.scrollChildIntoView(nodeID(key), { align: 'nearest' });
    });
  });

  // Expanding the already-focused row adds rows below it after the focus effect above has
  // already run. Re-reveal that same row when its own disclosure or child page changes, but
  // an unrelated stream update must not pull a reader back to a tool they scrolled away from
  // (#296). The signature names the focused row's own disclosure state, so ordinary window
  // refreshes do not schedule a new scroll. A signature change gets a few bounded layout
  // passes because culling may mount the target one pass later; explicit navigation cancels
  // any remaining passes.
  let revealedFocus: string | undefined;
  let revealPasses = 0;
  createEffect(() => {
    const focused = state.focusedGroup;
    windowed();
    if (focused === undefined || box === undefined) {
      revealedFocus = undefined;
      revealPasses = 0;
      return;
    }
    const key = focusedNodeKey(focused);
    const expanded = props.controller.expandedSets();
    const isExpanded = focused.startsWith('group:')
      ? expanded.groups.has(focused)
      : focused.startsWith('diff:')
        ? expanded.diffs.has(key)
        : expanded.tools.has(key);
    // Child paging changes this row's height too (#260).
    const signature = `${key}\u0000${isExpanded ? 'open' : 'closed'}\u0000${props.controller.childPageFor(key)}`;
    if (revealedFocus !== signature) {
      revealedFocus = signature;
      revealPasses = 4;
    }
    if (revealPasses <= 0) return;
    revealPasses -= 1;
    const scrollbox = box;
    scrollbox.afterLayout(() => {
      scrollbox.scrollChildIntoView(nodeID(key), { align: 'nearest' });
    });
  });

  const scroll = (move: ScrollMove) => {
    if (box === undefined) return;
    // Explicit navigation supersedes a queued focus/expansion reveal.
    revealPasses = 0;
    focusRevealToken += 1;
    const page = Math.max(1, box.height - 2);
    switch (move) {
      case 'pageUp': {
        if (box.scrollTop > 0) {
          box.scrollBy(-page);
          updateSticky();
          box.afterLayout(updateSticky);
          return;
        }
        // At the top: remember the first node and its row, reveal earlier nodes, then put
        // that same semantic node back at the same viewport row after layout (#243).
        const first = windowed().visible[0];
        const element = first === undefined ? undefined : box.findDescendantById(nodeID(first.key));
        const offset = element === undefined ? undefined : element.y - box.y;
        if (!props.controller.revealEarlier(props.sessionID, windowed().hidden, props.serverID))
          return;
        if (first !== undefined && offset !== undefined) {
          setPendingAnchor({ key: first.key, offset });
        }
        return;
      }
      case 'pageDown':
        box.scrollBy(page);
        updateSticky();
        box.afterLayout(updateSticky);
        return;
      case 'top':
        // Ctrl+Home reaches the earliest loaded node, not just the top of the current
        // render window. Any remaining server history stays advertised above (#251).
        props.controller.revealAllLoaded(props.sessionID, windowed().hidden, props.serverID);
        box.afterLayout(() => {
          box?.scrollTo(0);
          updateSticky();
        });
        return;
      case 'bottom':
        // Ctrl+End is an explicit return to the live tail, so the history strip clears
        // immediately rather than waiting for another layout event.
        setSticky(undefined);
        box.scrollTo(box.scrollHeight);
        box.afterLayout(updateSticky);
        return;
      default:
        assertNever(move);
    }
  };
  onMount(() => {
    props.onScrollHandle?.(scroll);
    if (box !== undefined) box.verticalScrollBar.onChange = updateSticky;
  });
  onCleanup(() => props.onScrollHandle?.(undefined));

  const sessionModel = (): { model?: ModelSelection; status?: 'loading' | 'unavailable' } => {
    const session = state.sessions[sessionKeyValue()];
    if (session?.model !== undefined) return { model: session.model };
    return session === undefined
      ? {}
      : props.controller.modelFor(session.serverID, session.directory, true);
  };

  return (
    <box flexGrow={1} flexDirection="column">
      <scrollbox
        ref={(element: ScrollBoxRenderable) => {
          box = element;
        }}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        paddingLeft={1}
        paddingRight={1}
      >
        <WelcomePanel
          controller={props.controller}
          theme={props.theme}
          width={props.width}
          greeting={props.controller.greetingFor(
            `conversation:${props.serverID}:${props.sessionID}`,
          )}
          agent={props.controller.currentAgentID()}
          model={sessionModel().model}
          modelStatus={sessionModel().status}
          directory={state.sessions[sessionKeyValue()]?.directory}
        />
        <Show when={windowed().hidden > 0 || transcript()?.olderCursor !== undefined}>
          <text fg={props.theme.dim}>
            {transcript()?.loading === true
              ? ' … loading earlier messages'
              : transcript()?.olderCheckFailed === true
                ? ' … earlier history check failed · PageUp at the top to retry'
                : ' … earlier messages · PageUp at the top to show them'}
          </text>
        </Show>
        <Show when={transcript()?.loading === true && nodes().length === 0}>
          <text fg={props.theme.dim}> Loading conversation…</text>
        </Show>
        {/* Row slots persist by index so a semantic prepend/reorder cannot remount every
            visible row. Unchanged nodes keep their object identity (#283), so a streamed
            tail update leaves those slots and their formatting untouched. */}
        <Index each={windowed().visible}>
          {(node) => (
            <>
              <Show when={isRunningExecution(node()) && queued().length > 0}>
                <QueuedPreview
                  items={queued()}
                  theme={props.theme}
                  width={props.width}
                  steerKey={actionHint(props.keymap, 'composer.steer')}
                />
              </Show>
              <box id={nodeID(node().key)} flexDirection="column" flexShrink={0}>
                <NodeView
                  controller={props.controller}
                  node={node()}
                  theme={props.theme}
                  detailed={state.detailed}
                  syntax={syntax()}
                  width={props.width}
                  focused={isNodeFocused(node(), state.focusedGroup)}
                  animate={props.animate}
                  ascii={props.ascii}
                  mcpServers={mcpServers()}
                  now={hintNow()}
                  backgroundKey={backgroundKey}
                  childPagePreviousKey={actionHint(props.keymap, 'transcript.childPrevious')}
                  childPageNextKey={actionHint(props.keymap, 'transcript.childNext')}
                  childPageFor={(toolID) => props.controller.childPageFor(toolID)}
                  shellBackground={(shellID) =>
                    props.controller.shellBackgroundState(shellID, props.sessionID, props.serverID)
                  }
                  workerStale={
                    props.controller.workerJobStatus(props.sessionID, props.serverID)?.state ===
                    'stale'
                  }
                />
              </box>
            </>
          )}
        </Index>
        {/* Fallback: no running marker to sit above (e.g. transcript not loaded). */}
        <Show when={!hasRunningMarker() && queued().length > 0}>
          <QueuedPreview
            items={queued()}
            theme={props.theme}
            width={props.width}
            steerKey={actionHint(props.keymap, 'composer.steer')}
          />
        </Show>
      </scrollbox>
      {/* Pinned above the composer: permissions and questions must be visible even when
          the reader is scrolled far up the transcript (#237, #213). */}
      <PermissionCard controller={props.controller} theme={props.theme} />
      <FormCard controller={props.controller} theme={props.theme} keymap={props.keymap} />
      <RequestStatusCard controller={props.controller} theme={props.theme} keymap={props.keymap} />
      <Show when={sticky()}>
        {(text: Accessor<string>) => (
          <box
            position="absolute"
            top={0}
            left={0}
            right={0}
            height={1}
            backgroundColor={props.theme.userBg}
            flexDirection="row"
            paddingLeft={1}
          >
            <text fg={props.theme.dim}>❯ </text>
            <text fg={props.theme.user}>
              {truncatePrompt(sanitizeText(text()), props.width - 6)}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}

const cat = [' /\\_/\\ ', '( o.o )', ' > ^ < '];

const catWidth = 7;
const hintWidth = 34;

export type WelcomeProps = Readonly<{
  controller: AppController;
  theme: Theme;
  width: number;
  /** Chosen once by the caller for this route; never derived reactively from a clock. */
  greeting: string;
  agent: string | undefined;
  model: ModelSelection | undefined;
  /** Shown instead of a model while the scoped catalog loads or cannot provide one (#192). */
  modelStatus?: 'loading' | 'unavailable' | undefined;
  directory: string | undefined;
}>;

/** Inline welcome panel; it scrolls away with the conversation (docs/13). */
export function WelcomePanel(props: WelcomeProps) {
  const model = () =>
    props.model !== undefined
      ? formatModelRef(props.model)
      : props.modelStatus === 'loading'
        ? 'Loading model…'
        : props.modelStatus === 'unavailable'
          ? 'model unavailable'
          : undefined;
  const detail = () => {
    const current = model();
    const agent = props.agent;
    if (agent === undefined) return current ?? 'agent unavailable';
    return current === undefined ? agent : `${agent} · ${current}`;
  };
  const directory = () => props.directory ?? props.controller.cwd;
  /** The hints only appear when the cat, the details and the hints all fit unsqueezed. */
  const wide = () =>
    props.width >= catWidth + 2 + Math.max(detail().length, directory().length, 16) + 2 + hintWidth;
  // Borderless on purpose (#194): the text column starts one row above the cat and ends
  // with the version as a subdued row under the working directory.
  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <box flexDirection="row">
        <box flexDirection="column" marginTop={1} marginRight={2} width={catWidth} flexShrink={0}>
          <For each={cat}>{(line) => <text fg={props.theme.accent}>{line}</text>}</For>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <text fg={props.theme.text}>
            <b>{props.greeting}</b>
          </text>
          <text fg={props.theme.dim}>{detail()}</text>
          <text fg={props.theme.dim}>{directory()}</text>
          <text fg={props.theme.dim}>{`margarita v${props.controller.version}`}</text>
        </box>
        <Show when={wide()}>
          {/* One row lower than the greeting so the hints align with the detail row. */}
          <box flexDirection="column" marginLeft={2} marginTop={1} flexShrink={0}>
            <text fg={props.theme.dim}>← overview (empty prompt)</text>
            <text fg={props.theme.dim}>Alt+P model</text>
            <text fg={props.theme.dim}>Ctrl+O details · F1 help</text>
          </box>
        </Show>
      </box>
    </box>
  );
}

function nodeID(key: string): string {
  return `node:${key}`;
}

/** The node key a focused group/diff/tool/worker row names. */
function focusedNodeKey(key: string): string {
  return key.startsWith('tool:') || key.startsWith('diff:') ? key.slice(key.indexOf(':') + 1) : key;
}

/** An execution marker in its streaming phase, the row the queued preview sits above. */
function isRunningExecution(node: TranscriptNode): boolean {
  return node.kind === 'execution' && node.segment.phase === 'running';
}

/** Whether this row is the focused tool group (or its inline diff, keyed by tool id). */
function isNodeFocused(node: TranscriptNode, focusedGroup: string | undefined): boolean {
  if (focusedGroup === undefined) return false;
  if (node.kind === 'tool-group') return focusedGroup === node.key;
  if (node.kind === 'tool')
    return focusedGroup === `tool:${node.tool.id}` || focusedGroup === `diff:${node.tool.id}`;
  if (node.kind === 'worker') return focusedGroup === node.key;
  return false;
}

/** Worker tone comes only from the server's status, never from a client-side timer. */
function workerColor(status: WorkerStatus, theme: Theme): string {
  const colors: Record<WorkerStatus, string> = {
    running: theme.accentLight,
    error: theme.error,
    cancelled: theme.warn,
    completed: theme.dim,
  };
  return colors[status];
}

function NodeView(props: {
  controller: AppController;
  node: TranscriptNode;
  theme: Theme;
  detailed: boolean;
  syntax: SyntaxStyle;
  width: number;
  focused: boolean;
  animate: boolean;
  ascii: boolean;
  mcpServers: readonly string[];
  now: number;
  /** Label of the user's effective `tools.background` binding, absent when unbound. */
  backgroundKey: string | undefined;
  /** Effective bindings for paging a focused execute call's nested children (#260). */
  childPagePreviousKey: string | undefined;
  childPageNextKey: string | undefined;
  childPageFor: (toolID: string) => number;
  /** Freshness-aware background state for this shell ID (#103, #259). */
  shellBackground: (shellID: string | undefined) => ShellBackgroundState;
  /** The retained worker rows were not re-confirmed on the last refresh (#230). */
  workerStale: boolean;
}) {
  const theme = () => props.theme;
  const activate = useActivate();
  return (
    <Switch>
      <Match when={props.node.kind === 'user' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'user'>>) => (
          <box marginTop={1} backgroundColor={theme().userBg} flexDirection="row">
            <text fg={theme().dim}>❯ </text>
            <text fg={theme().user}>
              {sanitizeText(node().text)}
              {node().attachments.length > 0 ? `  [${node().attachments.join(', ')}]` : ''}
            </text>
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'text' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'text'>>) => (
          <box marginTop={1} flexDirection="row">
            <text fg={theme().text}>● </text>
            <MarkdownBody
              content={() => sanitizeText(node().text)}
              syntax={props.syntax}
              theme={props.theme}
            />
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'reasoning' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'reasoning'>>) => {
          // Model-provided reasoning is Markdown in detailed mode, bounded by rendered
          // rows (#223). Compact mode never emits this node at all.
          const bounded = () =>
            boundedPreview(
              sanitizeText(node().text),
              previewBudget('reasoning', props.detailed),
              Math.max(8, props.width - 4),
            );
          return (
            <box marginTop={1} flexDirection="column" paddingLeft={2}>
              <text fg={theme().dim}>
                <i>{node().done ? '∴ Reasoning (model-provided)' : '∴ Reasoning (in progress…)'}</i>
              </text>
              <box paddingLeft={1} flexDirection="column">
                <MarkdownBody
                  content={() => bounded().text}
                  syntax={props.syntax}
                  theme={props.theme}
                />
                <Show when={bounded().hiddenRows > 0}>
                  <text fg={theme().dim}>
                    {`… ${bounded().hiddenRows} more rows · inspect to read the rest`}
                  </text>
                </Show>
              </box>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'reasoning-unavailable' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'reasoning-unavailable'>>) => (
          <text
            fg={theme().dim}
          >{`  Reasoning text not available (${node().tokens} tokens reported)`}</text>
        )}
      </Match>
      <Match when={props.node.kind === 'tool' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'tool'>>) => (
          <Show
            when={
              !props.detailed &&
              !node().expanded &&
              !isEditLike(node().tool) &&
              !hasOversizedDiff(node().tool)
            }
            fallback={
              <ToolView
                tool={node().tool}
                expanded={node().expanded}
                detailed={props.detailed}
                theme={theme()}
                syntax={props.syntax}
                width={props.width}
                focused={props.focused}
                mcpServers={props.mcpServers}
                childPagePreviousKey={props.childPagePreviousKey}
                childPageNextKey={props.childPageNextKey}
                childPageFor={props.childPageFor}
                userExpanded={node().userExpanded === true}
                onActivate={
                  !props.detailed && hasOversizedDiff(node().tool)
                    ? () => props.controller.toggleDiffExpanded(node().tool.id)
                    : undefined
                }
              />
            }
          >
            <ToolDisclosure
              controller={props.controller}
              tool={node().tool}
              detailed={props.detailed}
              theme={theme()}
              syntax={props.syntax}
              width={props.width}
              focused={props.controller.state.focusedGroup === `tool:${node().tool.id}`}
              mcpServers={props.mcpServers}
              childPagePreviousKey={props.childPagePreviousKey}
              childPageNextKey={props.childPageNextKey}
              childPageFor={props.childPageFor}
            />
          </Show>
        )}
      </Match>
      <Match when={props.node.kind === 'tool-group' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'tool-group'>>) => {
          // The background hint describes the one running call. It follows that call's own
          // row when the group is expanded, so the action is never shown twice (issue #111).
          const activeID = () => activeTool(node().tools)?.id;
          const hintText = (): string | undefined => {
            const key = props.backgroundKey;
            return key === undefined || !backgroundHint(node().live, props.now)
              ? undefined
              : `${key} to move to background`;
          };
          return (
            <box flexDirection="column" marginTop={1}>
              <text
                fg={props.focused ? theme().accent : theme().dim}
                onMouseUp={activate(() => props.controller.clickToolGroup(node().key))}
              >
                {`${props.focused ? '▸' : ' '}  ${node().summary}${node().running ? '…' : ''}${
                  props.focused ? '  (Enter)' : ''
                }`}
              </text>
              {/* One continuously updated action, only while the group is collapsed. */}
              <Show when={!node().expanded}>
                <Show when={node().live}>
                  {(live: Accessor<LiveTool>) => (
                    <>
                      <text fg={theme().dim}>
                        {`    └ ${truncateToWidth(sanitizeText(live().text), Math.max(8, props.width - 6))}`}
                      </text>
                      <Show when={hintText()}>
                        {(text: Accessor<string>) => (
                          <text fg={theme().dim}>{`      └ ${text()}`}</text>
                        )}
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
              <Show when={node().expanded}>
                <For each={node().tools}>
                  {(tool) => (
                    <>
                      <ToolDisclosure
                        controller={props.controller}
                        tool={tool}
                        detailed={props.detailed}
                        theme={theme()}
                        syntax={props.syntax}
                        width={props.width}
                        focused={props.controller.state.focusedGroup === `tool:${tool.id}`}
                        mcpServers={props.mcpServers}
                        childPagePreviousKey={props.childPagePreviousKey}
                        childPageNextKey={props.childPageNextKey}
                        childPageFor={props.childPageFor}
                      />
                      <Show when={activeID() === tool.id ? hintText() : undefined}>
                        {(text: Accessor<string>) => (
                          <text fg={theme().dim}>{`      └ ${text()}`}</text>
                        )}
                      </Show>
                    </>
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'shell' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'shell'>>) => {
          const bounded = () =>
            boundedPreview(
              sanitizeText(node().output ?? ''),
              previewBudget('shell', props.detailed),
              Math.max(8, props.width - 4),
            );
          const background = () => props.shellBackground(node().shellID);
          const backgroundNote = () =>
            node().status !== 'timeout'
              ? ''
              : background() === 'confirmed-running'
                ? ' · still running in background'
                : background() === 'last-known-running'
                  ? ' · last reported running · connection unavailable'
                  : '';
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme().text}>
                {`! ${truncateToWidth(sanitizeText(node().command), Math.max(8, props.width - 3))}`}
              </text>
              <text
                fg={
                  node().exitCode !== undefined && node().exitCode !== 0
                    ? theme().error
                    : background() === 'confirmed-running'
                      ? theme().warn
                      : theme().dim
                }
              >
                {`  └ ${node().status}${node().exitCode === undefined ? '' : ` (exit ${node().exitCode})`}${backgroundNote()}`}
              </text>
              <Show when={node().output}>
                <box flexDirection="column">
                  <text fg={theme().dim}>{bounded().text.split('\n').join('\n    ')}</text>
                  <Show when={bounded().hiddenRows > 0}>
                    <text fg={theme().dim}>
                      {`    … ${bounded().hiddenRows} more rows · ${props.detailed ? 'inspect' : 'Ctrl+O'} to read the rest`}
                    </text>
                  </Show>
                  <Show when={node().outputTruncated === 'server'}>
                    <text fg={theme().warn}>
                      {'  └ output truncated by the server; full text not shown'}
                    </text>
                  </Show>
                </box>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'notice' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'notice'>>) => (
          <text
            marginTop={1}
            fg={
              node().tone === 'error'
                ? theme().error
                : node().tone === 'warn'
                  ? theme().warn
                  : theme().dim
            }
          >
            {`  ${sanitizeText(node().text)}`}
          </text>
        )}
      </Match>
      <Match when={props.node.kind === 'worker' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'worker'>>) => {
          const worker = () => node().worker;
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={workerColor(worker().status, props.theme)}>
                {`  ${props.focused ? '▸' : '◇'} ${sanitizeText(worker().agent)} · ${sanitizeText(worker().description)} — ${workerStatusLabel(worker().status)}${worker().status === 'running' ? '…' : ''}${props.workerStale ? ' · stale' : ''}${props.focused ? '  (Enter)' : ''}`}
              </text>
              <Show when={node().expanded}>
                <text fg={theme().dim}>{`      child session ${worker().childSessionID}`}</text>
                <Show when={worker().title !== undefined}>
                  <text fg={theme().dim}>{`      ${sanitizeText(worker().title ?? '')}`}</text>
                </Show>
                <text fg={theme().dim}>
                  {`      started ${new Date(worker().startedAt).toISOString()}`}
                </text>
                <Show when={worker().completedAt !== undefined}>
                  <text fg={theme().dim}>
                    {`      completed ${new Date(worker().completedAt ?? 0).toISOString()}`}
                  </text>
                </Show>
                <text fg={theme().dim}>{'      result lives in the child session transcript'}</text>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'execution' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'execution'>>) => (
          <ExecutionMarkerView
            segment={node().segment}
            width={props.width}
            theme={theme()}
            animate={props.animate}
            ascii={props.ascii}
          />
        )}
      </Match>
      <Match when={props.node.kind === 'meta' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'meta'>>) => <text fg={theme().dim}>{`  ${node().text}`}</text>}
      </Match>
    </Switch>
  );
}

/** Renders one execution marker: live indicator while running, static after. */
function ExecutionMarkerView(props: {
  segment: ExecutionMarker;
  width: number;
  theme: Theme;
  animate: boolean;
  ascii: boolean;
}) {
  const running = () => props.segment.phase === 'running';
  const facts = (): ThrobberFacts => ({
    phase: props.segment.phase,
    startedAt: props.segment.startedAt,
    ...(props.segment.activity === undefined ? {} : { activity: props.segment.activity }),
  });
  const line = () => {
    const { phase, durationMs, completedAt } = props.segment;
    return phase === 'running'
      ? ''
      : markerText({
          phase,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(completedAt === undefined ? {} : { completedAt }),
        });
  };
  return (
    <Show
      when={running()}
      fallback={
        <text
          marginTop={1}
          fg={
            props.segment.phase === 'failed'
              ? props.theme.error
              : props.segment.phase === 'interrupted'
                ? props.theme.warn
                : props.theme.dim
          }
        >
          {`  ◌ ${line()}`}
        </text>
      }
    >
      <Throbber
        facts={facts()}
        width={props.width}
        theme={props.theme}
        animate={props.animate}
        ascii={props.ascii}
      />
    </Show>
  );
}

function indent(text: string): string {
  return text.split('\n').join('\n    ');
}

/**
 * One Markdown row. The content memo is the client-side revision boundary: when the node
 * object is unchanged, it never reruns, so the native renderable is not handed new content
 * on unrelated updates (#286). Native parse/layout counts are unavailable in OpenTUI.
 */
function MarkdownBody(props: { content: () => string; syntax: SyntaxStyle; theme: Theme }) {
  const content = createMemo(() => {
    countFormat('markdown-content');
    return props.content();
  });
  return (
    <markdown
      content={content()}
      syntaxStyle={props.syntax}
      treeSitterClient={getTreeSitterClient()}
      fg={props.theme.text}
      flexGrow={1}
      flexShrink={1}
    />
  );
}

/** One compact, individually disclosable tool row inside an expanded group (#281). */
function ToolDisclosure(props: {
  controller: AppController;
  tool: ToolCall;
  detailed: boolean;
  theme: Theme;
  syntax: SyntaxStyle;
  width: number;
  focused: boolean;
  mcpServers: readonly string[];
  childPagePreviousKey: string | undefined;
  childPageNextKey: string | undefined;
  childPageFor: (toolID: string) => number;
}) {
  const expanded = () =>
    props.controller.isToolExpanded(props.tool.id) ||
    props.tool.status === 'error' ||
    props.tool.executionError !== undefined ||
    props.tool.children?.some((child) => child.status === 'error') === true;
  const tone = () =>
    props.tool.status === 'error'
      ? props.theme.error
      : props.tool.status === 'running' || props.tool.status === 'streaming'
        ? props.theme.accent
        : props.focused
          ? props.theme.accent
          : props.theme.text;
  const status = () =>
    props.tool.status === 'error'
      ? 'failed'
      : props.tool.status === 'completed'
        ? 'done'
        : props.tool.status;
  const activate = useActivate();
  const summary = () =>
    `${props.focused ? '❯' : ' '} ${expanded() ? '▾' : '▸'} ${describeTool(props.tool, props.mcpServers)} · ${status()} · ${formatToolTiming(props.tool, clock)}`;
  return (
    // The focus/reveal path addresses this row by the same tool ID standalone calls use,
    // so Ctrl+Down can bring an individual disclosure into view (#281).
    <box id={nodeID(props.tool.id)} flexDirection="column">
      <text fg={tone()} onMouseUp={activate(() => props.controller.clickToolRow(props.tool.id))}>
        {truncateToWidth(summary(), Math.max(8, props.width - 4))}
      </text>
      <Show when={expanded()}>
        <ToolView
          tool={props.tool}
          expanded
          detailed={props.detailed}
          theme={props.theme}
          syntax={props.syntax}
          width={props.width}
          focused={props.focused}
          mcpServers={props.mcpServers}
          childPagePreviousKey={props.childPagePreviousKey}
          childPageNextKey={props.childPageNextKey}
          childPageFor={props.childPageFor}
          userExpanded={props.controller.isToolExpanded(props.tool.id)}
          showHeader={false}
        />
      </Show>
    </box>
  );
}

function ToolView(props: {
  tool: ToolCall;
  expanded: boolean;
  detailed: boolean;
  theme: Theme;
  syntax: SyntaxStyle;
  width: number;
  focused: boolean;
  mcpServers: readonly string[];
  /** Effective bindings for paging nested children; absent when unbound (#260). */
  childPagePreviousKey: string | undefined;
  childPageNextKey: string | undefined;
  childPageFor: (toolID: string) => number;
  /** The user explicitly grew this item beyond its mode default (#219). */
  userExpanded?: boolean;
  /** False when a disclosure row already names the tool (#281). */
  showHeader?: boolean;
  /** Mouse disclosure for a standalone compact row (#281). */
  onActivate?: (() => void) | undefined;
}) {
  const edit = createMemo(() => {
    if (props.tool.status === 'error') return undefined;
    const result = editDiff(props.tool);
    if (result !== undefined) countFormat('diff-normalize');
    return result;
  });
  // A completed edit-like call with no usable patch must say so instead of degrading to a
  // bare row: the server gave us nothing to show, which is different from no change at all.
  const unavailable = createMemo(() =>
    edit() === undefined && props.tool.status === 'completed' && isEditLike(props.tool)
      ? (toolPath(props.tool) ?? 'unknown')
      : undefined,
  );
  const lineWidth = () => Math.max(8, props.width - 4);
  // Child detail rows sit behind a `    ↳ ` prefix inside a padded box. Measuring them at
  // the full row width would let that prefix wrap one extra physical row and break the
  // aggregate page budget (#268).
  const childDetailWidth = () => Math.max(8, props.width - 10);
  const resultPreviewKind = (): PreviewKind => {
    const preview = semanticPreview(props.tool);
    return preview.kind;
  };
  const resultRows = () =>
    previewBudget(resultPreviewKind(), props.detailed, props.userExpanded === true);
  // Cap the patch before materializing a native <diff>; never reparse a mid-hunk slice.
  const clamped = createMemo(() => {
    const shown = edit();
    if (shown === undefined) return undefined;
    const clampedPatch = clampDiffPatch(
      shown.diff,
      previewBudget('diff', props.detailed, props.userExpanded === true),
    );
    countFormat('diff-clamp');
    return clampedPatch;
  });
  const showFullDiff = () => (clamped()?.hidden ?? 0) === 0;
  const clampHint = () =>
    props.detailed
      ? `… ${clamped()?.hidden ?? 0} more lines · inspect to read the rest`
      : `… ${clamped()?.hidden ?? 0} more lines · Enter to expand`;
  const resultPreview = createMemo(() => {
    const preview = semanticPreview(props.tool);
    const text = sanitizeText(preview.text);
    const bounded =
      props.tool.status === 'error'
        ? boundedTailPreview(text, resultRows(), lineWidth())
        : boundedPreview(text, resultRows(), lineWidth());
    countFormat('tool-preview');
    return { ...bounded, kind: preview.kind };
  });
  const failed = () => props.tool.status === 'error';
  const scriptFailed = () => props.tool.executionError !== undefined;
  const childrenVisible = () =>
    props.tool.children !== undefined &&
    (props.expanded ||
      failed() ||
      scriptFailed() ||
      props.tool.children.some((c) => c.status === 'error'));
  // A nested execute can report hundreds of MCP calls. Bound the *aggregate physical rows*
  // of the page, not only its widget count: labels plus each child's error/output rows must
  // fit the mode budget. Failures are prioritized; detailed/expanded only widen the budget
  // (#260, #268).
  const childBudget = () =>
    toolChildBudget({
      detailed: props.detailed,
      userExpanded: props.userExpanded === true,
    });
  const childView = createMemo(() =>
    pagedToolChildren(props.tool.children ?? [], childBudget(), props.childPageFor(props.tool.id)),
  );
  // Metadata is outside the nested-child budget: a script error or a thousand file parts
  // must still fit the mode's physical-row allowance (#277). Full values stay in the
  // inspector/copy payload; only this inline presentation is clipped.
  const scriptError = createMemo(() => {
    const error = props.tool.executionError;
    return error === undefined
      ? undefined
      : boundedTailPreview(
          sanitizeText(error),
          toolMetadataRowBudget('error', props.detailed, props.userExpanded === true),
          lineWidth(),
        );
  });
  const fileView = createMemo(() =>
    toolFileWindow(
      props.tool.files ?? [],
      toolMetadataRowBudget('files', props.detailed, props.userExpanded === true),
    ),
  );

  const bullet = () =>
    failed()
      ? props.theme.error
      : props.tool.status === 'completed'
        ? props.theme.success
        : props.theme.dim;
  const activate = useActivate();
  return (
    <box flexDirection="column" marginTop={1}>
      <Show when={props.showHeader !== false}>
        <box flexDirection="row" onMouseUp={activate(() => props.onActivate?.())}>
          <text fg={bullet()}>● </text>
          <text fg={props.theme.text}>
            {truncateToWidth(
              sanitizeText(
                edit() !== undefined
                  ? `${props.tool.name === 'write' ? 'Write' : 'Update'}(${describeTool(props.tool, props.mcpServers).slice(props.tool.name.length + 1)})`
                  : unavailable() !== undefined
                    ? `Changed(${unavailable()})`
                    : describeTool(props.tool, props.mcpServers),
              ),
              lineWidth(),
            )}
          </text>
          <Show when={props.detailed}>
            <text fg={props.theme.dim}>{`  ${formatToolTiming(props.tool, clock)}`}</text>
          </Show>
          <Show when={props.focused}>
            <text fg={props.theme.accent}>{props.detailed ? '  (I)' : '  (Enter)'}</text>
          </Show>
        </box>
      </Show>
      <Show when={scriptError()}>
        {(bounded: Accessor<{ text: string; hiddenRows: number }>) => (
          <>
            <text fg={props.theme.error}>{`  └ script failed: ${indent(bounded().text)}`}</text>
            <Show when={bounded().hiddenRows > 0}>
              <text fg={props.theme.error}>
                {truncateToWidth(
                  `    … ${bounded().hiddenRows} earlier error rows hidden · inspect for the full script error`,
                  lineWidth(),
                )}
              </text>
            </Show>
          </>
        )}
      </Show>
      <Show when={fileView().visible.length > 0}>
        <For each={fileView().visible}>
          {(file) => (
            <text fg={props.theme.dim}>
              {truncateToWidth(`  └ ${toolFileLabel(file)}`, lineWidth())}
            </text>
          )}
        </For>
        <Show when={fileView().hidden > 0}>
          <text fg={props.theme.dim}>
            {truncateToWidth(
              `    … ${fileView().hidden} more ${fileView().hidden === 1 ? 'file' : 'files'} · inspect for the full metadata`,
              lineWidth(),
            )}
          </text>
        </Show>
      </Show>
      <Show when={childrenVisible() ? props.tool.children : undefined}>
        {() => (
          <box flexDirection="column" paddingLeft={2}>
            <For each={childView().visible}>
              {(row) => {
                const child = row.child;
                const color = () =>
                  child.status === 'error'
                    ? props.theme.error
                    : child.status === 'running' || child.status === 'streaming'
                      ? props.theme.accent
                      : props.theme.dim;
                // The page budget decides how many detail rows this child may print.
                const error = () =>
                  child.error === undefined || row.errorRows === 0
                    ? undefined
                    : boundedTailPreview(
                        sanitizeText(child.error),
                        row.errorRows,
                        childDetailWidth(),
                      );
                const output = () =>
                  child.output === undefined || row.outputRows === 0
                    ? undefined
                    : boundedPreview(
                        sanitizeText(child.output),
                        row.outputRows,
                        childDetailWidth(),
                      );
                return (
                  <box flexDirection="column">
                    <text fg={color()}>
                      {truncateToWidth(
                        `└ ${childStatusMark(child.status)} ${childLabel(child.name, props.mcpServers)}${childInputSummary(child.input)}${childTimingLabel(child)}`,
                        lineWidth(),
                      )}
                    </text>
                    {/* A failed child always names itself; the allocated rows add its reason. */}
                    <Show when={error()}>
                      {(bounded: Accessor<{ text: string }>) => (
                        <text fg={props.theme.error}>{`    ↳ ${indent(bounded().text)}`}</text>
                      )}
                    </Show>
                    <Show when={output()}>
                      {(bounded: Accessor<{ text: string }>) => (
                        <text fg={props.theme.dim}>{`    ↳ ${indent(bounded().text)}`}</text>
                      )}
                    </Show>
                    <Show when={row.missingReason}>
                      <text fg={props.theme.dim}>
                        {truncateToWidth(
                          '    ↳ the server did not report a separate reason for this child',
                          lineWidth(),
                        )}
                      </text>
                    </Show>
                  </box>
                );
              }}
            </For>
            <Show when={childView().hidden > 0}>
              <text fg={props.theme.dim}>{childSummaryLine(childView(), lineWidth())}</text>
            </Show>
            <Show when={childView().pages > 1}>
              <text fg={props.theme.dim}>
                {childPageLine(
                  childView(),
                  lineWidth(),
                  props.focused
                    ? {
                        previous: props.childPagePreviousKey,
                        next: props.childPageNextKey,
                      }
                    : undefined,
                )}
              </text>
            </Show>
          </box>
        )}
      </Show>
      {/* Failures are never hidden, even in compact mode. */}
      <Show when={unavailable() !== undefined}>
        <text fg={props.theme.dim}>{'  └ diff unavailable for this change'}</text>
      </Show>
      <Show when={props.tool.error}>
        {(error: Accessor<string>) => {
          const bounded = () =>
            boundedTailPreview(
              sanitizeText(error()),
              previewBudget('output', props.detailed, props.userExpanded === true),
              lineWidth(),
            );
          return (
            <>
              <text fg={props.theme.error}>{`  └ ${indent(bounded().text)}`}</text>
              <Show when={bounded().hiddenRows > 0}>
                <text fg={props.theme.error}>
                  {`    … ${bounded().hiddenRows} earlier rows hidden · inspect for the full error`}
                </text>
              </Show>
            </>
          );
        }}
      </Show>
      <Show when={edit()}>
        {(shown: Accessor<NonNullable<ReturnType<typeof editDiff>>>) => (
          <box flexDirection="column" paddingLeft={2}>
            <text fg={props.theme.dim}>{`└ ${changeSummary(diffCounts(shown().diff))}`}</text>
            <Show
              when={showFullDiff()}
              fallback={
                <box flexDirection="column">
                  <For each={clamped()?.shown ?? []}>
                    {(line) => (
                      <text fg={diffLineFg(line.kind, props.theme)}>
                        {truncateToWidth(line.text, lineWidth())}
                      </text>
                    )}
                  </For>
                  <text
                    fg={props.focused ? props.theme.accent : props.theme.dim}
                    onMouseUp={activate(() => props.onActivate?.())}
                  >
                    {`${props.focused ? '▸ ' : '  '}${clampHint()}`}
                  </text>
                </box>
              }
            >
              <diff
                diff={shown().diff}
                view="unified"
                showLineNumbers
                syntaxStyle={props.syntax}
                treeSitterClient={getTreeSitterClient()}
                filetype={shown().filetype}
                fg={props.theme.text}
                lineNumberFg={props.theme.dim}
                addedBg={props.theme.addedBg}
                removedBg={props.theme.removedBg}
                addedSignColor={props.theme.success}
                removedSignColor={props.theme.error}
                wrapMode="none"
              />
            </Show>
          </box>
        )}
      </Show>
      <Show
        when={
          edit() === undefined && props.expanded && props.tool.output !== undefined && !failed()
        }
      >
        <box flexDirection="column">
          <text fg={props.theme.dim}>{`  └ ${indent(resultPreview().text)}`}</text>
          <Show when={resultPreview().hiddenRows > 0}>
            <text fg={props.theme.dim}>
              {`    … ${resultPreview().hiddenRows} more rows · inspect to read the rest`}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={props.tool.outputTruncated !== undefined}>
        <text fg={props.theme.warn}>
          {props.tool.outputTruncated === 'server'
            ? '  └ output truncated by the server; the full text is not available here'
            : '  └ output elided by this program (middle omitted); the full text was not retained'}
        </text>
      </Show>
    </box>
  );
}

function plural(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

function childStatusMark(status: ToolCallChild['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'error') return '✗';
  return '…';
}

function childLabel(name: string, mcpServers: readonly string[]): string {
  const identity = toolIdentity(name, mcpServers);
  return identity.kind === 'mcp' ? `${identity.server}.${identity.tool}` : sanitizeText(name);
}

/** Optional per-child duration; omitted unless both server timestamps exist (#231). */
function childTimingLabel(child: ToolCallChild): string {
  if (child.startedAt === undefined || child.completedAt === undefined) return '';
  const seconds = Math.max(0, child.completedAt - child.startedAt) / 1000;
  return ` · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`;
}

function childInputSummary(input: ToolCallChild['input']): string {
  if (input === undefined) return '';
  const value = Object.values(input).find(
    (entry) => typeof entry === 'string' && entry.trim() !== '',
  );
  if (typeof value !== 'string') return '';
  const line = value.split('\n')[0] ?? value;
  return `  ${truncatePrompt(sanitizeText(line), 72)}`;
}

/** One bounded row describing a capped child list; hidden identities stay in the domain. */
function childSummaryLine(view: ToolChildPage, width: number): string {
  const visibleFailed = view.visible.filter((row) => row.child.status === 'error').length;
  const counts = [
    view.summary.failed === 0
      ? undefined
      : visibleFailed === view.summary.failed
        ? `${view.summary.failed} failed`
        : `${view.summary.failed} failed (${visibleFailed} shown)`,
    view.summary.running === 0 ? undefined : `${view.summary.running} running`,
    view.summary.completed === 0 ? undefined : `${view.summary.completed} completed`,
  ].filter((entry): entry is string => entry !== undefined);
  const suffix = counts.length === 0 ? '' : ` · ${counts.join(' · ')}`;
  return truncateToWidth(
    `  … showing ${view.visible.length} of ${view.summary.total} nested calls${suffix}`,
    Math.max(8, width),
  );
}

/** Separate line so page controls are never truncated by the status counts. */
function childPageLine(
  view: ToolChildPage,
  width: number,
  paging?: { previous: string | undefined; next: string | undefined },
): string {
  const keys =
    paging?.previous === undefined || paging.next === undefined
      ? ''
      : ` · ${paging.previous}/${paging.next} page`;
  return truncateToWidth(`    page ${view.page + 1} of ${view.pages}${keys}`, Math.max(8, width));
}

/** Compact-mode colours for a clipped patch line; semantics match the full <diff> view. */
function diffLineFg(kind: PatchLine['kind'], theme: Theme): string {
  switch (kind) {
    case 'add':
      return theme.success;
    case 'del':
      return theme.error;
    case 'hunk':
      return theme.accent;
    case 'meta':
    case 'context':
      return theme.dim;
    default:
      return theme.text;
  }
}

/** Clip a pre-sanitized patch line to one terminal row; never wraps, so rows stay bounded. */
function truncateToWidth(text: string, width: number): string {
  return clipLineToCells(text, Math.max(0, width)).text;
}

function changeSummary(counts: { additions: number; deletions: number }): string {
  return `Added ${plural(counts.additions)}, removed ${plural(counts.deletions)}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function PermissionCard(props: { controller: AppController; theme: Theme }) {
  const pending = () => props.controller.pendingPermission();
  return (
    <Show when={pending()}>
      {(request: Accessor<PermissionPrompt>) => (
        <box
          border
          borderStyle="rounded"
          borderColor={props.theme.warn}
          title=" Permission needed "
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
          flexShrink={0}
        >
          <text fg={props.theme.text}>
            <b>{sanitizeSingleLine(request().action)}</b>
          </text>
          <For each={request().resources.slice(0, 6)}>
            {(resource) => <text fg={props.theme.dim}>{`  ${sanitizeSingleLine(resource)}`}</text>}
          </For>
          <Show when={request().resources.length > 6}>
            <text fg={props.theme.dim}>{`  … and ${request().resources.length - 6} more`}</text>
          </Show>
          <Show when={request().message}>
            {(message: Accessor<string>) => (
              <text fg={props.theme.dim}>{sanitizeText(message())}</text>
            )}
          </Show>
          <text>
            <For each={props.controller.permissionChoices()}>
              {(choice, index) => (
                <span
                  style={{
                    fg:
                      index() === props.controller.state.permissionChoice
                        ? props.theme.accent
                        : props.theme.dim,
                  }}
                >
                  {index() === props.controller.state.permissionChoice
                    ? `[${label(choice)}]`
                    : ` ${label(choice)} `}
                  {'  '}
                </span>
              )}
            </For>
          </text>
          <text fg={props.theme.dim}>
            {props.controller.state.permissionFocused
              ? '←/→ choose · Enter confirm · Esc reject'
              : 'Enter to review · Esc reject'}
          </text>
        </box>
      )}
    </Show>
  );
}

/** A pending agent question. It never takes focus by itself; a dedicated key opens it. */
function FormCard(props: { controller: AppController; theme: Theme; keymap: Keymap }) {
  const pending = () =>
    props.controller.pendingPermission() === undefined ? props.controller.pendingForm() : undefined;
  const openHint = () => actionHint(props.keymap, 'form.open') ?? 'Alt+Q';
  /** Count with the editor's own hidden/conditional rules, not the wire field list (#235). */
  const fieldCount = () => {
    const form = pending();
    return form === undefined ? 0 : initialVisibleFields(form).length;
  };
  return (
    <Show when={pending()}>
      {(form: Accessor<FormRequest>) => (
        <box
          border
          borderStyle="rounded"
          borderColor={props.theme.warn}
          title=" Question from the agent "
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
          flexShrink={0}
        >
          <text fg={props.theme.text}>
            <b>{form().title}</b>
          </text>
          <text fg={props.theme.dim}>
            {fieldCount() === 0
              ? `No questions to answer · ${openHint()} to acknowledge · Enter on an empty prompt also opens it`
              : `${fieldCount()} field${fieldCount() === 1 ? '' : 's'} · ${openHint()} to answer · Enter on an empty prompt also opens it`}
          </text>
        </box>
      )}
    </Show>
  );
}

function label(choice: string): string {
  return choice === 'once' ? 'Allow once' : choice === 'always' ? 'Always allow' : 'Reject';
}

/**
 * Nonblocking partial-data notice: one request endpoint can fail while the other succeeds,
 * or a location-wide form snapshot can be unavailable (#214, #258, #264). Cached requests
 * stay visible; the user gets an explicit retry instead of a false "nothing pending".
 */
function RequestStatusCard(props: { controller: AppController; theme: Theme; keymap: Keymap }) {
  const detail = () => {
    const error = props.controller.currentRequestError();
    if (error === undefined) return undefined;
    const parts = [error.forms, error.permissions].filter(
      (entry): entry is string => entry !== undefined && entry !== '',
    );
    return parts.length === 0 ? undefined : parts.join(' · ');
  };
  const retry = () => actionHint(props.keymap, 'requests.retry') ?? 'Alt+R';
  return (
    <Show when={detail()}>
      {(text: Accessor<string>) => (
        <box
          border
          borderStyle="rounded"
          borderColor={props.theme.warn}
          title=" Request refresh incomplete "
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
          flexShrink={0}
        >
          <text fg={props.theme.warn}>
            {`Some questions or permissions may be missing: ${text()}`}
          </text>
          <text fg={props.theme.dim}>{`Cached requests stay visible · ${retry()} retry`}</text>
        </box>
      )}
    </Show>
  );
}

/** A conversation not yet created on the server: welcome panel plus the prompt below. */
export function NewSessionView(props: {
  controller: AppController;
  serverID: string;
  directory: string;
  theme: Theme;
  width: number;
}) {
  const overview = () => props.controller.state.overview;
  const newModel = () => props.controller.modelFor(props.serverID, props.directory);
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <WelcomePanel
        controller={props.controller}
        theme={props.theme}
        width={props.width}
        greeting={props.controller.greetingFor(`new:${props.serverID}:${props.directory}`)}
        agent={overview().agent}
        model={newModel().model}
        modelStatus={newModel().status}
        directory={props.directory}
      />
    </scrollbox>
  );
}
