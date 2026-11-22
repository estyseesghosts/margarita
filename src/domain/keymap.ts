/**
 * Every bindable action. Configuration refers to these IDs, never raw key bytes.
 * `composer.steer` ships two universal bindings on purpose: `f6` works in every
 * terminal, while the modified Enter needs a terminal that reports modified keys
 * (kitty keyboard protocol — not every Windows Terminal build does). A config
 * override replaces the whole list for its action.
 */
export const actionIDs = [
  'agent.cycle',
  'agent.cyclePrevious',
  'agent.pick',
  'model.pick',
  'model.effort',
  'model.recentNext',
  'transcript.details',
  'transcript.copy',
  'transcript.pageUp',
  'transcript.pageDown',
  'transcript.top',
  'transcript.bottom',
  'transcript.groupPrevious',
  'transcript.groupNext',
  'transcript.inspect',
  'form.open',
  'history.search',
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
  'agent.cycle': ['shift+tab'],
  'agent.cyclePrevious': ['alt+shift+tab'],
  'agent.pick': ['f3'],
  'model.pick': ['alt+p'],
  // Alt+E is free in every supported terminal (Alt+C/D/P/Z are taken); mnemonic for "effort".
  'model.effort': ['alt+e'],
  'model.recentNext': ['f2'],
  'transcript.details': ['ctrl+o'],
  'transcript.copy': ['alt+c'],
  'transcript.pageUp': ['pageup'],
  'transcript.pageDown': ['pagedown'],
  'transcript.top': ['ctrl+home'],
  'transcript.bottom': ['ctrl+end'],
  'transcript.groupPrevious': ['ctrl+up'],
  'transcript.groupNext': ['ctrl+down'],
  // Plain `i` only opens the inspector for a focused row with an empty composer; otherwise
  // the router lets it type normally (#222).
  'transcript.inspect': ['i'],
  // Alt+Q opens the pending agent question without disturbing a nonempty draft.
  'form.open': ['alt+q'],
  'history.search': ['ctrl+r'],
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

export type Keymap = ReadonlyMap<ActionID, readonly KeyBinding[]>;

export type KeymapBuild = Readonly<{ keymap: Keymap; errors: readonly string[] }>;

/**
 * Builds the keymap from defaults plus overrides. Invalid or duplicate overrides are
 * reported and the default is kept, so a bad config never leaves an action unbound.
 */
export function buildKeymap(overrides: Readonly<Record<string, string>>): KeymapBuild {
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
  for (const [action, spec] of Object.entries(overrides).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isActionID(action)) {
      errors.push(`unknown action "${action}"`);
      continue;
    }
    const parsed = parseBinding(spec);
    if (!parsed.ok) {
      errors.push(`${action}: ${parsed.error}`);
      continue;
    }
    keymap.set(action, [parsed.binding]);
    requested.add(action);
  }
  // Restoring defaults can create further conflicts, so resolve until stable.
  while (true) {
    const rejected = new Set<ActionID>();
    for (const [index, action] of actionIDs.entries()) {
      for (const other of actionIDs.slice(index + 1)) {
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
    if (bindings.some((binding) => matches(binding, press))) return action;
  }
  return undefined;
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
