import {
  type Composer,
  deleteBackward,
  deleteForward,
  deletePreviousWhitespaceUnit,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  emptyComposer,
  insertText,
  leftOpensOverview,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
} from '../domain/composer.ts';
import {
  actionFor,
  type ActionID,
  canonicalizeKey,
  canonicalText,
  type Keymap,
  type KeyPress,
} from '../domain/keymap.ts';
import type { AppController } from './controller.ts';

/** A decoded key: identity, modifiers and the printable text it would insert, if any. */
export type KeyInput = KeyPress & Readonly<{ text?: string }>;

export type ScrollMove = 'pageUp' | 'pageDown' | 'top' | 'bottom';

export type RouterServices = Readonly<{
  openEditor: () => void;
  redraw: () => void;
  /** Scrolls the visible transcript; paging past the top loads earlier history. */
  scroll: (move: ScrollMove) => void;
  /**
   * Rows one PageUp/PageDown moves the overview selection. Optional so non-UI callers
   * and tests get a sensible page without supplying terminal dimensions.
   */
  overviewPageRows?: number;
  /** Patch/file rows one diff-dialog PageUp/PageDown moves, from the live terminal height. */
  diffPageRows?: number;
  /**
   * Copies the renderer's live text selection. The terminal selection itself belongs to
   * the UI layer, so the router only asks for an explicit copy.
   */
  copySelection?: () => void;
}>;

/**
 * Single precedence chain (docs/06): overlay > permission card > completion > global
 * actions > composer editing > navigation. Views never interpret keys themselves.
 * Returns true when the key was consumed.
 */
export function routeKey(
  controller: AppController,
  keymap: Keymap,
  rawKey: KeyInput,
  services: RouterServices,
): boolean {
  // Configured key roles are translated once here; every downstream handler keeps seeing
  // the canonical key it was written against (docs/06: no raw keys in view components).
  const canonical = canonicalizeKey(keymap, rawKey);
  const text = canonicalText(canonical);
  const key: KeyInput = { ...canonical, ...(text === undefined ? {} : { text }) };
  const state = controller.state;
  if (state.overlay.kind === 'help' && isPrintable(key)) {
    controller.closeOverlay();
    return routeKey(controller, keymap, key, services);
  }
  // Clipboard actions keep one precedence: they work in the composer, the overview, the
  // transcript, the inspector and modal dialogs, and none of them dismisses a dialog or
  // edits the composer on its own (docs/06).
  if (routeClipboardAction(controller, keymap, key, services)) return true;
  if (state.overlay.kind !== 'none') return routeOverlay(controller, keymap, key, services);
  if (state.route.kind === 'conversation' && controller.pendingPermission() !== undefined) {
    if (routePermission(controller, key)) return true;
  } else if (state.route.kind === 'conversation' && controller.pendingForm() !== undefined) {
    if (actionFor(keymap, key) === 'form.open') {
      // A dedicated action works with a nonempty composer; Enter with an empty prompt
      // remains the zero-learning path (#213).
      controller.openForm();
      return true;
    }
    if (state.composer.text === '' && key.name === 'return') {
      // Enter on an empty prompt opens the pending agent question.
      controller.openForm();
      return true;
    }
  }
  if (state.completion !== undefined && routeCompletion(controller, key)) return true;

  const action = actionFor(keymap, key);
  if (action !== undefined && runAction(controller, action, services)) return true;

  if (state.route.kind === 'overview' && state.overview.focus === 'list') {
    return routeOverviewList(controller, key);
  }
  return routeComposer(controller, key);
}

/**
 * Clipboard actions have their own precedence: paste routes through the common paste entry
 * point (which respects an editable overlay or form), selection copy never dismisses an
 * unrelated dialog, and response copy reads canonical messages only.
 */
function routeClipboardAction(
  controller: AppController,
  keymap: Keymap,
  key: KeyInput,
  services: RouterServices,
): boolean {
  switch (actionFor(keymap, key)) {
    case 'clipboard.paste':
      // Help is dismiss-on-paste; the same paste still belongs to the surface behind it.
      if (controller.state.overlay.kind === 'help') controller.closeOverlay();
      void controller.pasteFromClipboard();
      return true;
    case 'clipboard.copySelection':
      services.copySelection?.();
      return true;
    case 'transcript.copyLastResponse':
      void controller.copyLastResponse();
      return true;
    default:
      return false;
  }
}

function runAction(controller: AppController, action: ActionID, services: RouterServices): boolean {
  switch (action) {
    case 'agent.cycle':
      void controller.cycleAgent(1);
      return true;
    case 'agent.cyclePrevious':
      void controller.cycleAgent(-1);
      return true;
    case 'agent.pick':
      void controller.openAgentPicker();
      return true;
    case 'model.pick':
      void controller.openModelPicker();
      return true;
    case 'model.effort':
      void controller.openEffortPicker();
      return true;
    case 'model.recentNext':
      void controller.nextRecentModel();
      return true;
    case 'transcript.details':
      controller.toggleDetails();
      return true;
    case 'transcript.copy':
      controller.openCopyPicker();
      return true;
    case 'transcript.groupPrevious':
      controller.moveGroupFocus(-1);
      return true;
    case 'transcript.groupNext':
      controller.moveGroupFocus(1);
      return true;
    case 'transcript.childPrevious':
      if (controller.state.composer.text !== '') return false;
      return controller.moveFocusedChildPage(-1);
    case 'transcript.childNext':
      if (controller.state.composer.text !== '') return false;
      return controller.moveFocusedChildPage(1);
    case 'transcript.inspect':
      // `i` stays ordinary text unless a tool row is focused and no draft exists. Without
      // the focus check it would inspect the last tool on the first letter of a message.
      if (controller.state.composer.text !== '') return false;
      if (!controller.canInspectFocusedTool()) return false;
      return controller.openInspector();
    case 'form.open':
      if (controller.pendingForm() !== undefined) controller.openForm();
      return true;
    case 'requests.retry':
      if (controller.state.route.kind === 'conversation') controller.retryInputRequests();
      return true;
    case 'transcript.pageUp':
      // The overview has its own scroller; never hand the key to the transcript's stale
      // callback. Paging moves the selected row in list focus and is a no-op in the
      // composer, so typing a draft is never redirected (#238).
      if (controller.state.route.kind === 'overview') {
        controller.moveOverviewPage(-1, services.overviewPageRows ?? 10);
        return true;
      }
      services.scroll('pageUp');
      return true;
    case 'transcript.pageDown':
      if (controller.state.route.kind === 'overview') {
        controller.moveOverviewPage(1, services.overviewPageRows ?? 10);
        return true;
      }
      services.scroll('pageDown');
      return true;
    case 'transcript.top':
      if (controller.state.route.kind === 'overview') {
        controller.selectOverviewEdge('first');
        return true;
      }
      services.scroll('top');
      return true;
    case 'transcript.bottom':
      if (controller.state.route.kind === 'overview') {
        controller.selectOverviewEdge('last');
        return true;
      }
      services.scroll('bottom');
      return true;
    case 'history.search':
      controller.openHistorySearch();
      return true;
    case 'composer.stash':
      controller.toggleStash();
      return true;
    case 'composer.editor':
      services.openEditor();
      return true;
    case 'composer.newline':
      controller.setComposer(insertText(controller.state.composer, '\n'));
      return true;
    case 'composer.undo':
      controller.undo();
      return true;
    case 'composer.redo':
      controller.redo();
      return true;
    case 'composer.wordDeleteForward': {
      const composer = controller.state.composer;
      const next = deleteWordForward(composer);
      const removed = composer.text.slice(
        composer.cursor,
        composer.cursor + (composer.text.length - next.text.length),
      );
      controller.killText(removed);
      controller.setComposer(next);
      return true;
    }
    case 'composer.yank': {
      const killed = controller.yankText();
      if (killed === '') return true;
      controller.setComposer(insertText(controller.state.composer, killed));
      return true;
    }
    case 'composer.steer':
      // Contextual: empty composer sends now the next queued follow-up (FIFO);
      // draft text steers the draft.
      if (controller.state.composer.text === '') {
        void controller.promoteNextQueued();
      } else {
        void controller.steer();
      }
      return true;
    case 'screen.redraw':
      services.redraw();
      return true;
    case 'tools.background':
      void controller.backgroundTools();
      return true;
    case 'tasks.toggle':
      controller.openTasks();
      return true;
    case 'help.show':
      controller.setOverlay({ kind: 'help' });
      return true;
    default:
      return false;
  }
}

function routeOverlay(
  controller: AppController,
  keymap: Keymap,
  key: KeyInput,
  services: RouterServices,
): boolean {
  const overlay = controller.state.overlay;
  if (overlay.kind === 'inspector') {
    controller.inspectorKey(key);
    return true;
  }
  if (overlay.kind === 'diff' && !(key.ctrl && key.name === 'c')) {
    controller.diffKey(key, services.diffPageRows);
    return true;
  }
  if (overlay.kind === 'tasks' && actionFor(keymap, key) === 'tasks.toggle') {
    controller.closeOverlay();
    return true;
  }
  if (overlay.kind === 'tasks' && !(key.ctrl && key.name === 'c')) {
    controller.tasksKey(key);
    return true;
  }
  if (overlay.kind === 'revert') {
    controller.revertKey(key.ctrl && key.name === 'c' ? { name: 'escape' } : key);
    return true;
  }
  if (overlay.kind === 'form' && !(key.ctrl && key.name === 'c')) {
    controller.formKey(key);
    return true;
  }
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    controller.closeOverlay();
    return true;
  }
  switch (overlay.kind) {
    case 'model-picker':
      if (key.name === 'up') controller.moveModelPicker(-1);
      else if (key.name === 'down') controller.moveModelPicker(1);
      else if (key.name === 'return') void controller.acceptModelPicker();
      else if (key.name === 'backspace') controller.setModelPickerQuery(overlay.query.slice(0, -1));
      else if (isPrintable(key)) controller.setModelPickerQuery(overlay.query + key.text);
      return true;
    case 'effort-picker':
      if (key.name === 'up') controller.moveEffortPicker(-1);
      else if (key.name === 'down') controller.moveEffortPicker(1);
      else if (key.name === 'return') void controller.acceptEffortPicker();
      else if (key.name === 'backspace')
        controller.setEffortPickerQuery(overlay.query.slice(0, -1));
      else if (isPrintable(key)) controller.setEffortPickerQuery(overlay.query + key.text);
      return true;
    case 'copy-picker':
      if (key.name === 'up') controller.moveCopyPicker(-1);
      else if (key.name === 'down') controller.moveCopyPicker(1);
      else if (key.name === 'return') void controller.acceptCopyPicker();
      else if (key.name === 'backspace') controller.setCopyPickerQuery(overlay.query.slice(0, -1));
      else if (isPrintable(key)) controller.setCopyPickerQuery(overlay.query + key.text);
      return true;
    case 'rewind-picker':
      if (key.name === 'up') controller.moveRewindPicker(-1);
      else if (key.name === 'down') controller.moveRewindPicker(1);
      else if (key.name === 'return') void controller.acceptRewindPicker();
      return true;
    case 'agent-picker':
      if (key.name === 'up') controller.moveAgentPicker(-1);
      else if (key.name === 'down') controller.moveAgentPicker(1);
      else if (key.name === 'return') void controller.acceptAgentPicker();
      else if (key.name === 'backspace') controller.setAgentPickerQuery(overlay.query.slice(0, -1));
      else if (isPrintable(key)) controller.setAgentPickerQuery(overlay.query + key.text);
      return true;
    case 'history-search':
      if (actionFor(keymap, key) === 'history.search') controller.openHistorySearch();
      else if (key.name === 'return') controller.acceptHistorySearch();
      else if (key.name === 'backspace') controller.setHistoryQuery(overlay.query.slice(0, -1));
      else if (isPrintable(key)) controller.setHistoryQuery(overlay.query + key.text);
      return true;
    case 'queue': {
      // Server-qualified: selection and actions stay on the displayed host (#78, #88).
      const items = controller.currentView()?.queued ?? [];
      // Clamp a stale index when an item is delivered/cancelled while the dialog is open,
      // so selection never lands on a removed item or a wrong row (#88).
      let index = overlay.index;
      if (items.length === 0) index = 0;
      else if (index < 0 || index >= items.length) index = items.length - 1;
      if (index !== overlay.index) controller.setOverlay({ kind: 'queue', index });
      const item = items[index];
      if (key.name === 'pageup' && items.length > 0) {
        controller.setOverlay({
          kind: 'queue',
          index: Math.max(0, index - 10),
        });
      } else if (key.name === 'pagedown' && items.length > 0) {
        controller.setOverlay({
          kind: 'queue',
          index: Math.min(items.length - 1, index + 10),
        });
      } else if (key.name === 'home' && items.length > 0) {
        controller.setOverlay({ kind: 'queue', index: 0 });
      } else if (key.name === 'end' && items.length > 0) {
        controller.setOverlay({ kind: 'queue', index: items.length - 1 });
      } else if (key.name === 'up' && items.length > 0) {
        controller.setOverlay({
          kind: 'queue',
          index: (index - 1 + items.length) % items.length,
        });
      } else if (key.name === 'down' && items.length > 0) {
        controller.setOverlay({ kind: 'queue', index: (index + 1) % items.length });
      } else if (item !== undefined && (key.name === 'delete' || key.name === 'x')) {
        void controller.cancelQueued(item.id);
      } else if (item !== undefined && key.name === 's') {
        void controller.promoteQueued(item.id);
      }
      return true;
    }
    case 'help':
      if (key.name === 'pageup' || key.name === 'pagedown') {
        const offset = Math.max(0, (overlay.offset ?? 0) + (key.name === 'pageup' ? -10 : 10));
        controller.setOverlay({ kind: 'help', offset });
      } else if (key.name === 'home') controller.setOverlay({ kind: 'help', offset: 0 });
      else if (key.name === 'return' || key.name === 'q') controller.closeOverlay();
      return true;
    case 'usage':
    case 'status':
      if (key.name === 'return' || key.name === 'q') controller.closeOverlay();
      return true;
    case 'unpair-confirm':
      if (key.name === 'return' || key.name === 'y') void controller.confirmUnpair();
      else if (key.name === 'escape' || key.name === 'n') controller.closeOverlay();
      return true;
    case 'servers':
      if (key.name === 'return' || key.name === 'q') controller.closeOverlay();
      return true;
    case 'form':
      controller.formKey(key);
      return true;
    case 'diff':
      controller.diffKey(key);
      return true;
    case 'none':
      return false;
    default:
      return true;
  }
}

function routePermission(controller: AppController, key: KeyInput): boolean {
  // The permission card owns arrows and Enter only while the draft is empty, so typing
  // a follow-up is never hijacked (docs/20).
  if (controller.state.composer.text !== '') return false;
  // A newly arrived (or replaced) request starts unfocused. The first Enter/arrow is an
  // explicit review step, never an approval the user could not see (#237).
  if (!controller.state.permissionFocused) {
    if (key.name === 'return' || key.name === 'enter') controller.focusPermission();
    else if (key.name === 'left' || (key.shift && key.name === 'tab'))
      controller.movePermissionChoice(-1);
    else if (key.name === 'right' || key.name === 'tab') controller.movePermissionChoice(1);
    else if (key.name === 'escape') void controller.answerPermission('reject');
    else return false;
    return true;
  }
  if (key.name === 'left' || (key.shift && key.name === 'tab')) controller.movePermissionChoice(-1);
  else if (key.name === 'right' || key.name === 'tab') controller.movePermissionChoice(1);
  else if (key.name === 'return') void controller.answerPermission();
  else if (key.name === 'escape') void controller.answerPermission('reject');
  else return false;
  return true;
}

function routeCompletion(controller: AppController, key: KeyInput): boolean {
  if (key.name === 'up') controller.moveCompletion(-1);
  else if (key.name === 'down') controller.moveCompletion(1);
  else if (key.name === 'tab' && !key.shift) controller.acceptCompletion();
  else if (key.name === 'escape') controller.dismissCompletion();
  else if (key.name === 'return' && !key.shift && !key.ctrl && !key.alt) {
    controller.acceptCompletion();
  } else return false;
  return true;
}

function routeOverviewList(controller: AppController, key: KeyInput): boolean {
  if (key.name === '[') controller.cycleOverviewTab(-1);
  else if (key.name === ']') controller.cycleOverviewTab(1);
  else if (key.name === 'up') controller.moveOverviewSelection(-1);
  else if (key.name === 'down') controller.moveOverviewSelection(1);
  else if (key.name === 'return' || key.name === 'right') controller.attachSelected();
  else if (key.name === 'escape') controller.focusOverviewComposer();
  else if (key.name === '?') controller.setOverlay({ kind: 'help' });
  else if (key.ctrl && (key.name === 'c' || key.name === 'd'))
    controller.armOrExit(`Ctrl+${key.name.toUpperCase()}`);
  else if (isPrintable(key)) {
    // Typing any printable key (including 'n') focuses and fills the new-session composer.
    controller.activateOverviewComposer(key.text);
  } else return false;
  return true;
}

function routeComposer(controller: AppController, key: KeyInput): boolean {
  const state = controller.state;
  const composer = state.composer;
  const edit = (next: Composer): true => {
    controller.setComposer(next);
    return true;
  };
  const killBackward = (next: Composer): true => {
    controller.killText(composer.text.slice(next.cursor, composer.cursor));
    return edit(next);
  };
  const killForward = (next: Composer): true => {
    controller.killText(
      composer.text.slice(
        composer.cursor,
        composer.cursor + (composer.text.length - next.text.length),
      ),
    );
    return edit(next);
  };

  if (key.ctrl) {
    switch (key.name) {
      case 'c':
        if (controller.isRunning()) void controller.interrupt();
        else if (composer.text !== '') edit(emptyComposer);
        else controller.armOrExit('Ctrl+C');
        return true;
      case 'd':
        if (composer.text !== '') return edit(deleteForward(composer));
        controller.armOrExit('Ctrl+D');
        return true;
      case 'a':
        return edit(moveLineStart(composer));
      case 'e':
        return edit(moveLineEnd(composer));
      case 'w':
        return killBackward(deletePreviousWhitespaceUnit(composer));
      case 'backspace':
        return killBackward(deleteWordBackward(composer));
      case 'u':
        return killBackward(deleteToLineStart(composer));
      case 'k':
        return killForward(deleteToLineEnd(composer));
      case 'p':
        controller.historyUp();
        return true;
      case 'n':
        controller.historyDown();
        return true;
      case 'left':
        return edit(moveWordLeft(composer));
      case 'right':
        return edit(moveWordRight(composer));
      default:
        return false;
    }
  }
  if (key.alt) {
    if (key.name === 'b' || key.name === 'left') return edit(moveWordLeft(composer));
    if (key.name === 'f' || key.name === 'right') return edit(moveWordRight(composer));
    if (key.name === 'backspace') return killBackward(deleteWordBackward(composer));
  }

  switch (key.name) {
    case 'return':
    case 'enter':
      if (key.shift) return edit(insertText(composer, '\n'));
      // An empty prompt gives Enter the selected tool group first; otherwise it submits.
      if (composer.text === '' && controller.toggleFocusedGroup()) return true;
      void controller.submit();
      return true;
    case 'linefeed':
      return edit(insertText(composer, '\n'));
    case 'backspace':
      // An empty composer with attachments drops the newest chip instead of doing nothing.
      if (composer.text === '' && controller.state.attachments.length > 0) {
        controller.detachLastAttachment();
        return true;
      }
      return edit(deleteBackward(composer));
    case 'delete':
      return edit(deleteForward(composer));
    case 'left':
      if (state.route.kind !== 'overview' && leftOpensOverview(composer, blockers(controller))) {
        controller.openOverview();
        return true;
      }
      return edit(moveLeft(composer));
    case 'right':
      return edit(moveRight(composer));
    case 'home':
      return edit(moveLineStart(composer));
    case 'end':
      return edit(moveLineEnd(composer));
    case 'up': {
      const moved = moveVertical(composer, -1);
      if (moved !== undefined) return edit(moved);
      if (state.route.kind === 'overview' && composer.text === '') {
        controller.moveOverviewSelection(-1);
        return true;
      }
      // An empty composer recalls the newest pending queued follow-up (Up-to-edit); fall
      // back to prompt history when nothing is queued.
      if (composer.text === '' && state.route.kind === 'conversation') {
        void controller.recallQueuedUp();
        return true;
      }
      controller.historyUp();
      return true;
    }
    case 'down': {
      const moved = moveVertical(composer, 1);
      if (moved !== undefined) return edit(moved);
      controller.historyDown();
      return true;
    }
    case 'space':
      // Space is the second disclosure key whenever a transcript row owns the empty
      // prompt; otherwise it remains ordinary composer text (#281).
      if (composer.text === '' && controller.toggleFocusedGroup()) return true;
      return edit(insertText(composer, ' '));
    case 'escape':
      return controller.handleEscapeKey();
    case 'tab':
      return true;
    default:
      break;
  }
  if (isPrintable(key)) return edit(insertText(composer, key.text));
  return false;
}

function blockers(controller: AppController) {
  return {
    modalOpen: controller.state.overlay.kind !== 'none',
    completionOpen: controller.state.completion !== undefined,
    shellMode: false,
  };
}

function isPrintable(key: KeyInput): key is KeyInput & { text: string } {
  if (key.ctrl || key.alt || key.text === undefined || key.text === '') return false;
  // Reject control characters; everything else (including wide Unicode) is text.
  return !Array.from(key.text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}
