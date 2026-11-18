import {
  type Composer,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
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
import { actionFor, type ActionID, type Keymap, type KeyPress } from '../domain/keymap.ts';
import type { AppController } from './controller.ts';

/** A decoded key: identity, modifiers and the printable text it would insert, if any. */
export type KeyInput = KeyPress & Readonly<{ text?: string }>;

export type ScrollMove = 'pageUp' | 'pageDown' | 'top' | 'bottom';

export type RouterServices = Readonly<{
  openEditor: () => void;
  redraw: () => void;
  /** Scrolls the visible transcript; paging past the top loads earlier history. */
  scroll: (move: ScrollMove) => void;
}>;

/**
 * Single precedence chain (docs/06): overlay > permission card > completion > global
 * actions > composer editing > navigation. Views never interpret keys themselves.
 * Returns true when the key was consumed.
 */
export function routeKey(
  controller: AppController,
  keymap: Keymap,
  key: KeyInput,
  services: RouterServices,
): boolean {
  const state = controller.state;
  if (state.overlay.kind !== 'none') return routeOverlay(controller, key);
  if (state.route.kind === 'conversation' && controller.pendingPermission() !== undefined) {
    if (routePermission(controller, key)) return true;
  } else if (
    state.route.kind === 'conversation' &&
    controller.pendingForm() !== undefined &&
    state.composer.text === '' &&
    key.name === 'return'
  ) {
    // Enter on an empty prompt opens the pending agent question.
    controller.openForm();
    return true;
  }
  if (state.completion !== undefined && routeCompletion(controller, key)) return true;

  const action = actionFor(keymap, key);
  if (action !== undefined && runAction(controller, action, services)) return true;

  if (state.route.kind === 'overview' && state.overview.focus === 'list') {
    return routeOverviewList(controller, key);
  }
  return routeComposer(controller, key);
}

function runAction(controller: AppController, action: ActionID, services: RouterServices): boolean {
  switch (action) {
    case 'agent.cycle':
      void controller.cycleAgent(1);
      return true;
    case 'agent.cyclePrevious':
      void controller.cycleAgent(-1);
      return true;
    case 'model.pick':
      void controller.openModelPicker();
      return true;
    case 'model.recentNext':
      void controller.nextRecentModel();
      return true;
    case 'transcript.details':
      controller.toggleDetails();
      return true;
    case 'transcript.groupPrevious':
      controller.moveGroupFocus(-1);
      return true;
    case 'transcript.groupNext':
      controller.moveGroupFocus(1);
      return true;
    case 'transcript.pageUp':
      services.scroll('pageUp');
      return true;
    case 'transcript.pageDown':
      services.scroll('pageDown');
      return true;
    case 'transcript.top':
      services.scroll('top');
      return true;
    case 'transcript.bottom':
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
      if (controller.currentSession() !== undefined)
        controller.setOverlay({ kind: 'tasks', index: 0 });
      return true;
    case 'help.show':
      controller.setOverlay({ kind: 'help' });
      return true;
    default:
      return false;
  }
}

function routeOverlay(controller: AppController, key: KeyInput): boolean {
  const overlay = controller.state.overlay;
  if (overlay.kind === 'diff' && !(key.ctrl && key.name === 'c')) {
    controller.diffKey(key);
    return true;
  }
  if (overlay.kind === 'tasks' && key.ctrl && key.name === 't') {
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
    case 'history-search':
      if (key.ctrl && key.name === 'r') controller.openHistorySearch();
      else if (key.name === 'return') controller.acceptHistorySearch();
      else if (key.name === 'backspace') controller.setHistoryQuery(overlay.query.slice(0, -1));
      else if (isPrintable(key)) controller.setHistoryQuery(overlay.query + key.text);
      return true;
    case 'queue': {
      const session = controller.currentSession();
      const items = session === undefined ? [] : (controller.state.inbox[session.id] ?? []);
      const item = items[overlay.index];
      if (key.name === 'up' && items.length > 0) {
        controller.setOverlay({
          kind: 'queue',
          index: (overlay.index - 1 + items.length) % items.length,
        });
      } else if (key.name === 'down' && items.length > 0) {
        controller.setOverlay({ kind: 'queue', index: (overlay.index + 1) % items.length });
      } else if (item !== undefined && (key.name === 'delete' || key.name === 'x')) {
        void controller.cancelQueued(item.id);
      } else if (item !== undefined && key.name === 's') {
        void controller.promoteQueued(item.id);
      }
      return true;
    }
    case 'help':
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
  else if (key.name === 'return' && controller.state.completion?.kind === 'file') {
    controller.acceptCompletion();
  } else return false;
  return true;
}

function routeOverviewList(controller: AppController, key: KeyInput): boolean {
  if (key.name === 'up') controller.moveOverviewSelection(-1);
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
      case 'backspace':
        return edit(deleteWordBackward(composer));
      case 'u':
        return edit(deleteToLineStart(composer));
      case 'k':
        return edit(deleteToLineEnd(composer));
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
      case 'return':
        // Empty composer: contextual send-now for the next queued follow-up (FIFO);
        // with draft text, steer the draft as before.
        if (composer.text === '') {
          void controller.promoteNextQueued();
          return true;
        }
        void controller.steer();
        return true;
      default:
        return false;
    }
  }
  if (key.alt) {
    if (key.name === 'b' || key.name === 'left') return edit(moveWordLeft(composer));
    if (key.name === 'f' || key.name === 'right') return edit(moveWordRight(composer));
    if (key.name === 'backspace') return edit(deleteWordBackward(composer));
    if (key.name === 'return') {
      // Empty composer: contextual send-now for the next queued follow-up (FIFO);
      // with draft text, steer the draft as before.
      if (composer.text === '') {
        void controller.promoteNextQueued();
        return true;
      }
      void controller.steer();
      return true;
    }
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
    case 'escape':
      controller.clearGroupFocus();
      if (state.exitArmed || state.notice !== undefined) controller.clearNotice();
      return true;
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
