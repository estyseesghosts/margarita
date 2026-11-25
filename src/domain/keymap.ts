/**
 * Every bindable action. Configuration refers to these IDs, never raw key bytes.
 * `composer.steer` ships two universal bindings on purpose: `f6` works in every
 * terminal, while the modified Enter needs a terminal that reports modified keys
 * (kitty keyboard protocol — not every Windows Terminal build does). A config
 * override replaces the whole list for its action.
 */
/**
 * Key roles for keys that were previously hardcoded in the router and dialog handlers.
 * They are excluded from `actionFor` (they are translations, not commands); a config
 * override renames the physical key that produces the same canonical key downstream.
 */
export const keyRoleActionIDs = [
  'nav.up',
  'nav.down',
  'nav.left',
  'nav.right',
  'nav.pageUp',
  'nav.pageDown',
  'nav.home',
  'nav.end',
  'nav.confirm',
  'nav.cancel',
  'nav.tab',
  'nav.backspace',
  'nav.delete',
  'nav.space',
  'nav.helpAlt',
  'help.closeAlt',
  'ui.exit',
  'ui.forceExit',
  'composer.moveToStart',
  'composer.moveToEnd',
  'composer.deleteWordLeft',
  'composer.deleteToStart',
  'composer.deleteToEnd',
  'composer.historyPrevious',
  'composer.historyNext',
  'composer.wordLeft',
  'composer.wordRight',
  'composer.shiftNewline',
  'queue.remove',
  'queue.steer',
  'form.decline',
  'form.openUrl',
  'form.copyUrl',
  'inspector.search',
  'confirmation.yes',
  'confirmation.no',
  'diff.info',
  'tasks.propose',
  'tasks.reject',
  'tasks.backgroundAll',
  'tasks.cancel',
  'tasks.edit',
] as const;

export type KeyRoleActionID = (typeof keyRoleActionIDs)[number];

export const actionIDs = [
  ...keyRoleActionIDs,
  'agent.cycle',
  'agent.cyclePrevious',
  'agent.pick',
  'model.pick',
  'model.effort',
  'model.recentNext',
  'transcript.details',
  'transcript.copy',
  'transcript.copyLastResponse',
  'transcript.pageUp',
  'transcript.pageDown',
  'transcript.top',
  'transcript.bottom',
  'transcript.groupPrevious',
  'transcript.groupNext',
  'transcript.childPrevious',
  'transcript.childNext',
  'transcript.inspect',
  'form.open',
  'requests.retry',
  'history.search',
  'clipboard.paste',
  'clipboard.copySelection',
  'composer.stash',
  'composer.editor',
  'composer.newline',
  'composer.undo',
  'composer.redo',
  'composer.wordDeleteForward',
  'composer.yank',
  'composer.steer',
  'screen.redraw',
  'tasks.toggle',
  'tools.background',
  'help.show',
] as const;

export type ActionID = (typeof actionIDs)[number];

/** A single key with modifiers. There is deliberately no chord/sequence form. */
export type KeyBinding = Readonly<{
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}>;

export type KeyPress = Readonly<{
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}>;

export const defaultBindings: Readonly<Record<ActionID, readonly string[]>> = {
  'nav.up': ['up'],
  'nav.down': ['down'],
  'nav.left': ['left'],
  'nav.right': ['right'],
  'nav.pageUp': ['pageup'],
  'nav.pageDown': ['pagedown'],
  'nav.home': ['home'],
  'nav.end': ['end'],
  'nav.confirm': ['enter'],
  'nav.cancel': ['escape'],
  'nav.tab': ['tab'],
  'nav.backspace': ['backspace'],
  'nav.delete': ['delete'],
  'nav.space': ['space'],
  'nav.helpAlt': ['?'],
  'help.closeAlt': ['q'],
  'ui.exit': ['ctrl+c'],
  'ui.forceExit': ['ctrl+d'],
  'composer.moveToStart': ['ctrl+a'],
  'composer.moveToEnd': ['ctrl+e'],
  'composer.deleteWordLeft': ['ctrl+w', 'alt+backspace'],
  'composer.deleteToStart': ['ctrl+u'],
  'composer.deleteToEnd': ['ctrl+k'],
  'composer.historyPrevious': ['ctrl+p'],
  'composer.historyNext': ['ctrl+n'],
  'composer.wordLeft': ['alt+b', 'ctrl+left'],
  'composer.wordRight': ['alt+f', 'ctrl+right'],
  'composer.shiftNewline': ['shift+enter'],
  'queue.remove': ['x'],
  'queue.steer': ['s'],
  'form.decline': ['ctrl+x'],
  'form.openUrl': ['o'],
  'form.copyUrl': ['c'],
  'inspector.search': ['/'],
  'confirmation.yes': ['y'],
  'confirmation.no': ['n'],
  'diff.info': ['t'],
  'tasks.propose': ['a'],
  'tasks.reject': ['r'],
  'tasks.backgroundAll': ['b'],
  'tasks.cancel': ['x'],
  'tasks.edit': ['e'],
  'agent.cycle': ['shift+tab'],
  'agent.cyclePrevious': ['alt+shift+tab'],
  'agent.pick': ['f3'],
  'model.pick': ['alt+p'],
  // Alt+E is free in every supported terminal (Alt+C/D/P/Z are taken); mnemonic for "effort".
  'model.effort': ['alt+e'],
  'model.recentNext': ['f2'],
  'transcript.details': ['ctrl+o'],
  'transcript.copy': ['alt+c'],
  // Alt+Shift+C copies canonical assistant text, never the rendered rows (issue #5).
  'transcript.copyLastResponse': ['alt+shift+c'],
  'transcript.pageUp': ['pageup'],
  'transcript.pageDown': ['pagedown'],
  'transcript.top': ['ctrl+home'],
  'transcript.bottom': ['ctrl+end'],
  'transcript.groupPrevious': ['ctrl+up'],
  'transcript.groupNext': ['ctrl+down'],
  // Brackets page a focused execute call's nested child rows; outside that context they stay
  // ordinary text (or the overview's tab keys).
  'transcript.childPrevious': ['['],
  'transcript.childNext': [']'],
  // Plain `i` only opens the inspector for a focused row with an empty composer; otherwise
  // the router lets it type normally (#222).
  'transcript.inspect': ['i'],
  // Alt+Q opens the pending agent question without disturbing a nonempty draft.
  'form.open': ['alt+q'],
  // Retry the request reconciliation after a partial permission/form fetch failure.
  'requests.retry': ['alt+r'],
  'history.search': ['ctrl+r'],
  // Ctrl+Shift+V is the terminal-native paste in many terminals; where it is forwarded it
  // must not fall through to a different action. Terminals that consume it never send it.
  'clipboard.paste': ['ctrl+v', 'ctrl+shift+v'],
  'clipboard.copySelection': ['ctrl+shift+c'],
  'composer.stash': ['ctrl+s'],
  'composer.editor': ['ctrl+g'],
  'composer.newline': ['ctrl+j'],
  // Ctrl+Z is swallowed by some terminals; Alt+Z is the documented fallback.
  'composer.undo': ['ctrl+z', 'alt+z'],
  'composer.redo': ['ctrl+shift+z'],
  'composer.wordDeleteForward': ['alt+d'],
  'composer.yank': ['ctrl+y'],
  'composer.steer': ['f6', 'ctrl+enter', 'alt+enter'],
  'screen.redraw': ['ctrl+l'],
  'tasks.toggle': ['ctrl+t'],
  'tools.background': ['ctrl+b'],
  'help.show': ['f1'],
};

export type BindingParse = { ok: true; binding: KeyBinding } | { ok: false; error: string };

/** Parses `ctrl+o`, `shift+tab`, `alt+p`, `f2`. Whitespace (chords) is rejected. */
export function parseBinding(spec: string): BindingParse {
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === '') return { ok: false, error: 'empty binding' };
  if (/\s/.test(trimmed)) {
    return { ok: false, error: `"${spec}" looks like a chord; only single keys are supported` };
  }
  const parts = trimmed.split('+');
  const key = parts.pop();
  if (key === undefined || key === '') return { ok: false, error: `"${spec}" has no key` };
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const modifier of parts) {
    if (modifier === 'ctrl' || modifier === 'control') ctrl = true;
    else if (modifier === 'alt' || modifier === 'meta' || modifier === 'option') alt = true;
    else if (modifier === 'shift') shift = true;
    else return { ok: false, error: `unknown modifier "${modifier}" in "${spec}"` };
  }
  return { ok: true, binding: { key: key === 'return' ? 'enter' : key, ctrl, alt, shift } };
}

export function matches(binding: KeyBinding, press: KeyPress): boolean {
  const name = press.name === 'return' ? 'enter' : press.name.toLowerCase();
  return (
    binding.key === name &&
    binding.ctrl === press.ctrl &&
    binding.alt === press.alt &&
    binding.shift === press.shift
  );
}

export function formatBinding(binding: KeyBinding): string {
  const parts = [
    binding.ctrl ? 'ctrl' : '',
    binding.alt ? 'alt' : '',
    binding.shift ? 'shift' : '',
  ];
  return [...parts.filter((part) => part !== ''), binding.key].join('+');
}

/** Human key label for hints and docs: `Ctrl+B`, `Shift+Tab`, `F6`. */
export function bindingLabel(binding: KeyBinding): string {
  const named: Readonly<Record<string, string>> = {
    escape: 'Esc',
    enter: 'Enter',
    backspace: 'Backspace',
    delete: 'Delete',
    tab: 'Tab',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    home: 'Home',
    end: 'End',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
  };
  const modifiers = [
    binding.ctrl ? 'Ctrl' : '',
    binding.alt ? 'Alt' : '',
    binding.shift ? 'Shift' : '',
  ].filter((part) => part !== '');
  const key = named[binding.key] ?? binding.key.toUpperCase();
  return [...modifiers, key].join('+');
}

/**
 * The first usable label for an action, or undefined when it is unbound (or bound only to
 * keys a hint cannot describe). Never advertises an action the user cannot press.
 */
export function actionHint(keymap: Keymap, action: ActionID): string | undefined {
  const binding = keymap.get(action)?.[0];
  return binding === undefined ? undefined : bindingLabel(binding);
}

export type KeyOverride = string | readonly string[];

export type Keymap = ReadonlyMap<ActionID, readonly KeyBinding[]>;

export type KeymapBuild = Readonly<{ keymap: Keymap; errors: readonly string[] }>;

/**
 * The input layer normalizes `enter` to `return`; key roles must emit that same name or
 * downstream handlers (which compare against `return`) would stop seeing confirmation keys.
 */
const keyRoleNames: Partial<Record<KeyRoleActionID, string>> = { 'nav.confirm': 'return' };

/** The canonical key a key role produces downstream, i.e. its shipped default binding. */
function canonicalBinding(action: KeyRoleActionID): KeyBinding | undefined {
  const spec = defaultBindings[action][0];
  if (spec === undefined) return undefined;
  const parsed = parseBinding(spec);
  return parsed.ok ? parsed.binding : undefined;
}

/**
 * Rewrites a configured key role to the key its handlers understand. Roles with identity
 * defaults only change the key when the user remaps them, so ordinary typing is unaffected.
 */
export function canonicalizeKey(keymap: Keymap, press: KeyPress): KeyPress {
  for (const action of keyRoleActionIDs) {
    if (!keymap.get(action)?.some((binding) => matches(binding, press))) continue;
    const canonical = canonicalBinding(action);
    if (canonical !== undefined)
      return {
        name: keyRoleNames[action] ?? canonical.key,
        ctrl: canonical.ctrl,
        alt: canonical.alt,
        shift: canonical.shift,
      };
  }
  return press;
}

/** Text carried by a canonical key, when it is an unmodified printable character. */
export function canonicalText(press: KeyPress): string | undefined {
  if (press.ctrl || press.alt || press.shift || press.name.length !== 1) return undefined;
  return press.name;
}

/**
 * Builds the keymap from defaults plus overrides. An override may replace all bindings with
 * one key, several keys, or `unbound` to remove them. Invalid or conflicting overrides are
 * reported and the default is kept, so a bad config never leaves an action unbound.
 */
export function buildKeymap(overrides: Readonly<Record<string, KeyOverride>>): KeymapBuild {
  const errors: string[] = [];
  const keymap = new Map<ActionID, readonly KeyBinding[]>();
  for (const action of actionIDs) {
    const bindings: KeyBinding[] = [];
    for (const spec of defaultBindings[action]) {
      const parsed = parseBinding(spec);
      if (parsed.ok) bindings.push(parsed.binding);
      else errors.push(`${action}: invalid default binding "${spec}"`);
    }
    keymap.set(action, bindings);
  }
  const defaults = new Map(keymap);
  const requested = new Set<ActionID>();
  for (const [action, value] of Object.entries(overrides).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isActionID(action)) {
      errors.push(`unknown action "${action}"`);
      continue;
    }
    if (value === 'unbound') {
      keymap.set(action, []);
      requested.add(action);
      continue;
    }
    const specs = typeof value === 'string' ? [value] : value;
    const bindings: KeyBinding[] = [];
    let invalid = false;
    for (const spec of specs) {
      const parsed = parseBinding(spec);
      if (!parsed.ok) {
        errors.push(`${action}: ${parsed.error}`);
        invalid = true;
      } else bindings.push(parsed.binding);
    }
    if (invalid) continue;
    keymap.set(action, bindings);
    requested.add(action);
  }
  // Key roles are translations, not commands: they may share keys with commands and with
  // each other because their contexts never overlap at dispatch time.
  const roles = new Set<string>(keyRoleActionIDs);
  while (true) {
    const rejected = new Set<ActionID>();
    for (const [index, action] of actionIDs.entries()) {
      if (roles.has(action)) continue;
      for (const other of actionIDs.slice(index + 1)) {
        if (roles.has(other)) continue;
        const clash = keymap
          .get(action)
          ?.find((binding) =>
            keymap.get(other)?.some((candidate) => sameBinding(binding, candidate)),
          );
        if (clash === undefined) continue;
        errors.push(`${action} and ${other}: "${formatBinding(clash)}" is bound to both actions`);
        if (requested.has(action)) rejected.add(action);
        if (requested.has(other)) rejected.add(other);
      }
    }
    if (rejected.size === 0) break;
    for (const action of rejected) {
      const bindings = defaults.get(action);
      if (bindings !== undefined) keymap.set(action, bindings);
      requested.delete(action);
    }
  }
  return { keymap, errors };
}

export function actionFor(keymap: Keymap, press: KeyPress): ActionID | undefined {
  for (const [action, bindings] of keymap) {
    if (isKeyRole(action)) continue;
    if (bindings.some((binding) => matches(binding, press))) return action;
  }
  return undefined;
}

function isKeyRole(value: string): value is KeyRoleActionID {
  return (keyRoleActionIDs as readonly string[]).includes(value);
}

function isActionID(value: string): value is ActionID {
  return (actionIDs as readonly string[]).includes(value);
}

function sameBinding(left: KeyBinding, right: KeyBinding): boolean {
  return (
    left.key === right.key &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift
  );
}
