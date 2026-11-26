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
  backgroundHint,
  boundedPreview,
  boundedTailPreview,
  describeTool,
  formatToolTiming,
  type LiveTool,
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
import { strings } from '../i18n/index.ts';
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
  /** Receives the viewport-preserving Ctrl+O transition for key routing. */
  onDetailsHandle?: (handler: (() => void) | undefined) => void;
  /**
   * Benchmark-only observation hook. Production leaves it undefined; keeping it optional
   * means the projector does no extra work unless a caller explicitly asks for counters.
   */
  onProjectionStats?: ((stats: ProjectionStats) => void) | undefined;
}>;

type NodeOf<K extends TranscriptNode['kind']> = Extract<TranscriptNode, { kind: K }>;

/**
 * A semantic reading anchor: a stable transcript node key plus that row's vertical offset
 * inside the scrollbox. Never a raw `scrollTop`, array index or `<Index>` slot — all three
 * change when older history is prepended or compact/detailed projection changes (#243, #355).
 */
type SemanticAnchor = Readonly<{
  key: string;
  offset: number;
  /** History prepend must survive several layouts while a slow page is in flight. */
  holdWhileLoading: boolean;
  /** Layout passes left for a projection change that has not mounted the target yet. */
  passes: number;
}>;

/** Rows whose keys are derived from canonical message identity and survive a mode change. */
function isCrossModeStable(node: TranscriptNode): boolean {
  return node.kind === 'user' || node.kind === 'text';
}

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
  const detail =
    failed.find((status) => status.detail !== undefined)?.detail ??
    strings.transcript.background.refreshFailed;
  return retained
    ? strings.transcript.background.retained(detail)
    : strings.transcript.background.unavailable(detail);
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
        ? background.reduce((view, notice) => view.insertAfterTool(notice.toolID, [notice]), folded)
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
  // One logical history window: how many folded nodes from loaded history may be mounted.
  // Physical row cost is handled by the scrollbox's viewport culling and by per-item caps,
  // never by choosing a different set of nodes relative to the tail (#355 repair).
  const windowed = createMemo(() =>
    windowNodeView(nodes(), props.controller.transcriptWindow(props.sessionID, props.serverID)),
  );
  // Server-confirmed pending user follow-ups, FIFO (server order) — rendered in the
  // activity region right above the running task marker, never inside the composer.
  const queued = createMemo(() =>
    (state.inbox[sessionKeyValue()] ?? []).filter((item) => item.kind === 'user'),
  );
  const hasRunningMarker = createMemo(() => {
    // Recompute whenever the projection changes; the controller answers from execution-marker
    // state instead of scanning every presentation node (#audit-2 task 7).
    nodes();
    return props.controller.hasRunningMarker(props.sessionID, props.serverID);
  });
  let box: ScrollBoxRenderable | undefined;
  const renderer = useRenderer();
  const syntax = createMemo(() => createSyntaxStyle(props.theme, renderer.nativeScene));
  const [sticky, setSticky] = createSignal<string | undefined>(undefined);
  /**
   * The single pending semantic anchor, captured and restored by the helpers below. It is
   * used only for operations that deliberately change material before/around the viewport:
   * history prepend and global compact/detailed reprojection. Ordinary streaming relies on
   * the scrollbox and unchanged mounted rows instead (#355 repair).
   */
  const [pendingAnchor, setPendingAnchor] = createSignal<SemanticAnchor | undefined>(undefined);
  const nodeIndexFor = () =>
    props.controller.presentationIndexFor(props.sessionID, props.serverID).keyToIndex;

  /** Captures an actual mounted row's key and offset, without reading raw `scrollTop`. */
  const captureAnchor = (
    key: string,
    holdWhileLoading: boolean,
    passes: number,
  ): SemanticAnchor | undefined => {
    if (box === undefined) return undefined;
    const element = box.findDescendantById(nodeID(key));
    if (element === undefined) return undefined;
    return { key, offset: element.y - box.y, holdWhileLoading, passes };
  };

  /** PageUp at the true top: remember the first mounted row before expanding/fetching. */
  const captureHistoryAnchor = (): SemanticAnchor | undefined => {
    const first = windowed().visible[0];
    return first === undefined ? undefined : captureAnchor(first.key, true, 0);
  };

  /**
   * Ctrl+O while reading history: prefer a mounted user/assistant-text row (its key comes
   * from canonical message identity and exists in both modes). If the viewport holds only
   * tool rows, use the nearest stable row and keep its relative position; if none is mounted,
   * search backward through the loaded presentation for the nearest one.
   */
  const captureCrossModeAnchor = (): SemanticAnchor | undefined => {
    if (box === undefined) return undefined;
    const scrollbox = box;
    let onScreen: SemanticAnchor | undefined;
    let nearestAbove: SemanticAnchor | undefined;
    for (const node of windowed().visible) {
      if (!isCrossModeStable(node)) continue;
      const anchor = captureAnchor(node.key, false, 6);
      if (anchor === undefined) continue;
      if (anchor.offset >= 0 && anchor.offset < scrollbox.height) {
        onScreen ??= anchor;
      } else if (anchor.offset <= 0) {
        nearestAbove ??= anchor;
      }
    }
    if (onScreen !== undefined) return onScreen;
    if (nearestAbove !== undefined) return nearestAbove;
    const top = windowed().visible[0];
    const index = top === undefined ? undefined : nodeIndexFor().get(top.key);
    if (index === undefined) return undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const node = nodes().at(cursor);
      if (node === undefined || !isCrossModeStable(node)) continue;
      props.controller.ensureTranscriptNodeVisible(props.sessionID, node.key, props.serverID);
      return { key: node.key, offset: 0, holdWhileLoading: false, passes: 6 };
    }
    return undefined;
  };

  /**
   * The viewport-preserving Ctrl+O transition. The state mutation stays in the controller;
   * only the view can capture the terminal viewport. At the live tail no anchor is needed —
   * bottom-follow retains the tail. While reading history, restore the cross-mode anchor
   * after the reprojected transcript has laid out.
   */
  const toggleDetails = (): void => {
    if (box === undefined || followsLiveTail(box.scrollTop, box.scrollHeight, box.height)) {
      props.controller.toggleDetails();
      return;
    }
    const anchor = captureCrossModeAnchor();
    props.controller.toggleDetails();
    if (anchor !== undefined) setPendingAnchor(anchor);
  };

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

  // A route/host switch must never carry the previous conversation's pinned prompt or anchor.
  createEffect(() => {
    // Track owner identity; the values themselves are read through props elsewhere.
    void props.sessionID;
    void props.serverID;
    setSticky(undefined);
    setPendingAnchor(undefined);
    box?.afterLayout(updateSticky);
  });

  /**
   * The single anchor-restore effect shared by history prepend and Ctrl+O reprojection.
   * A history anchor stays alive across every layout while a slow page is in flight (#243),
   * and is released only after the target has been restored and loading has settled. A
   * cross-mode anchor gets a few bounded passes because culling may mount its row later; it
   * is released as soon as the row is positioned. No raw `scrollTop` and no competing
   * scrollTo/scrollBy effects are involved.
   */
  createEffect(() => {
    const anchor = pendingAnchor();
    const loading = transcript()?.loading === true;
    // A prepended page or a compact/detailed projection schedules another restoration.
    windowed();
    if (anchor === undefined || box === undefined) return;
    const scrollbox = box;
    scrollbox.afterLayout(() => {
      const target = scrollbox.findDescendantById(nodeID(anchor.key));
      if (target === undefined) {
        if (anchor.holdWhileLoading) return;
        if (anchor.passes > 0) setPendingAnchor({ ...anchor, passes: anchor.passes - 1 });
        else setPendingAnchor(undefined);
        return;
      }
      const offset = target.y - scrollbox.y;
      if (offset !== anchor.offset) scrollbox.scrollBy(offset - anchor.offset);
      if (anchor.holdWhileLoading ? !loading : true) setPendingAnchor(undefined);
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
        // At the true top: capture the first mounted semantic row *before* expanding the
        // window or requesting an older page, then put that same row back after layout (#243).
        const anchor = captureHistoryAnchor();
        if (!props.controller.revealEarlier(props.sessionID, windowed().hidden, props.serverID))
          return;
        if (anchor !== undefined) setPendingAnchor(anchor);
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
        // Ctrl+End is an explicit return to live follow: clear the reading chrome and any
        // in-flight anchor immediately, then jump to the tail. Future output follows.
        setPendingAnchor(undefined);
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
    props.onDetailsHandle?.(toggleDetails);
    if (box !== undefined) box.verticalScrollBar.onChange = updateSticky;
  });
  onCleanup(() => {
    props.onScrollHandle?.(undefined);
    props.onDetailsHandle?.(undefined);
  });

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
              ? strings.transcript.history.loadingEarlier
              : transcript()?.olderCheckFailed === true
                ? strings.transcript.history.checkFailed
                : strings.transcript.history.hidden}
          </text>
        </Show>
        <Show when={transcript()?.loading === true && nodes().length === 0}>
          <text fg={props.theme.dim}>{strings.transcript.history.loadingConversation}</text>
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
        ? strings.chrome.welcome.loadingModel
        : props.modelStatus === 'unavailable'
          ? strings.chrome.welcome.modelUnavailable
          : undefined;
  const detail = () => {
    const current = model();
    const agent = props.agent;
    if (agent === undefined) return current ?? strings.chrome.welcome.agentUnavailable;
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
          <text fg={props.theme.dim}>
            {strings.chrome.productVersion(props.controller.version)}
          </text>
        </box>
        <Show when={wide()}>
          {/* One row lower than the greeting so the hints align with the detail row. */}
          <box flexDirection="column" marginLeft={2} marginTop={1} flexShrink={0}>
            <text fg={props.theme.dim}>{strings.chrome.welcome.overviewHint}</text>
            <text fg={props.theme.dim}>{strings.chrome.welcome.modelHint}</text>
            <text fg={props.theme.dim}>{strings.chrome.welcome.detailsHint}</text>
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
                <i>
                  {node().done
                    ? strings.transcript.reasoning.done
                    : strings.transcript.reasoning.inProgress}
                </i>
              </text>
              <box paddingLeft={1} flexDirection="column">
                <MarkdownBody
                  content={() => bounded().text}
                  syntax={props.syntax}
                  theme={props.theme}
                />
                <Show when={bounded().hiddenRows > 0}>
                  <text fg={theme().dim}>
                    {strings.transcript.reasoning.hiddenRows(bounded().hiddenRows)}
                  </text>
                </Show>
              </box>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'reasoning-unavailable' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'reasoning-unavailable'>>) => (
          <text fg={theme().dim}>{strings.transcript.reasoning.unavailable(node().tokens)}</text>
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
              : strings.transcript.backgroundHint(key);
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
                ? strings.transcript.shell.stillRunning
                : background() === 'last-known-running'
                  ? strings.transcript.shell.lastReportedRunning
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
                {`${strings.transcript.shell.status(node().status, node().exitCode)}${backgroundNote()}`}
              </text>
              <Show when={node().output}>
                <box flexDirection="column">
                  <text fg={theme().dim}>{bounded().text.split('\n').join('\n    ')}</text>
                  <Show when={bounded().hiddenRows > 0}>
                    <text fg={theme().dim}>
                      {strings.transcript.shell.hiddenRows(
                        bounded().hiddenRows,
                        props.detailed ? 'inspect' : 'Ctrl+O',
                      )}
                    </text>
                  </Show>
                  <Show when={node().outputTruncated === 'server'}>
                    <text fg={theme().warn}>{strings.transcript.shell.outputTruncated}</text>
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
                {strings.transcript.worker.line(
                  props.focused ? '▸' : '◇',
                  sanitizeText(worker().agent),
                  sanitizeText(worker().description),
                  workerStatusLabel(worker().status),
                  worker().status === 'running' ? '…' : '',
                  props.workerStale ? ' · stale' : '',
                  props.focused ? '  (Enter)' : '',
                )}
              </text>
              <Show when={node().expanded}>
                <text fg={theme().dim}>
                  {strings.transcript.worker.childSession(worker().childSessionID)}
                </text>
                <Show when={worker().title !== undefined}>
                  <text fg={theme().dim}>{`      ${sanitizeText(worker().title ?? '')}`}</text>
                </Show>
                <text fg={theme().dim}>
                  {strings.transcript.worker.started(new Date(worker().startedAt).toISOString())}
                </text>
                <Show when={worker().completedAt !== undefined}>
                  <text fg={theme().dim}>
                    {strings.transcript.worker.completed(
                      new Date(worker().completedAt ?? 0).toISOString(),
                    )}
                  </text>
                </Show>
                <text fg={theme().dim}>{strings.transcript.worker.resultLocation}</text>
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
      ? strings.transcript.tool.clamps.detailed(String(clamped()?.hidden ?? 0))
      : strings.transcript.tool.clamps.compact(String(clamped()?.hidden ?? 0));
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
                  ? `${props.tool.name === 'write' ? strings.transcript.tool.write : strings.transcript.tool.update}(${describeTool(props.tool, props.mcpServers).slice(props.tool.name.length + 1)})`
                  : unavailable() !== undefined
                    ? strings.transcript.tool.changed(unavailable() ?? 'unknown')
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
            <text fg={props.theme.error}>
              {strings.transcript.tool.scriptFailed(indent(bounded().text))}
            </text>
            <Show when={bounded().hiddenRows > 0}>
              <text fg={props.theme.error}>
                {truncateToWidth(
                  strings.transcript.tool.scriptRowsHidden(bounded().hiddenRows),
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
            {truncateToWidth(strings.transcript.tool.moreFiles(fileView().hidden), lineWidth())}
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
                        {truncateToWidth(strings.transcript.tool.childMissingReason, lineWidth())}
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
        <text fg={props.theme.dim}>{strings.transcript.tool.diffUnavailable}</text>
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
                  {strings.transcript.tool.earlierRowsHidden(bounded().hiddenRows)}
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
              {strings.transcript.tool.moreRows(resultPreview().hiddenRows)}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={props.tool.outputTruncated !== undefined}>
        <text fg={props.theme.warn}>
          {props.tool.outputTruncated === 'server'
            ? strings.transcript.tool.outputTruncated
            : strings.transcript.tool.outputElided}
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
      : strings.transcript.tool.failedCount(
          view.summary.failed,
          visibleFailed === view.summary.failed ? undefined : visibleFailed,
        ),
    view.summary.running === 0
      ? undefined
      : strings.transcript.tool.runningCount(view.summary.running),
    view.summary.completed === 0
      ? undefined
      : strings.transcript.tool.completedCount(view.summary.completed),
  ].filter((entry): entry is string => entry !== undefined);
  const suffix = counts.length === 0 ? '' : ` · ${counts.join(' · ')}`;
  return truncateToWidth(
    strings.transcript.tool.childSummary(view.visible.length, view.summary.total, suffix),
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
      : strings.transcript.tool.pageKeys(paging.previous, paging.next);
  return truncateToWidth(
    strings.transcript.tool.childPage(view.page + 1, view.pages, keys),
    Math.max(8, width),
  );
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
  return strings.transcript.tool.changeSummary(plural(counts.additions), plural(counts.deletions));
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
          title={strings.transcript.permission.title}
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
            <text fg={props.theme.dim}>
              {strings.transcript.permission.more(request().resources.length - 6)}
            </text>
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
              ? strings.transcript.permission.focusedHints
              : strings.transcript.permission.hints}
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
          title={strings.transcript.formCard.title}
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
              ? strings.transcript.formCard.noQuestions(openHint())
              : strings.transcript.formCard.fields(fieldCount(), openHint())}
          </text>
        </box>
      )}
    </Show>
  );
}

function label(choice: string): string {
  return choice === 'once'
    ? strings.transcript.permission.allowOnce
    : choice === 'always'
      ? strings.transcript.permission.alwaysAllow
      : strings.transcript.permission.reject;
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
          title={strings.transcript.requests.title}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
          flexShrink={0}
        >
          <text fg={props.theme.warn}>{strings.transcript.requests.missing(text())}</text>
          <text fg={props.theme.dim}>{strings.transcript.requests.cached(retry())}</text>
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
