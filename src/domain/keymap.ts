/** Every bindable action. Configuration refers to these IDs, never raw key bytes. */
export const actionIDs = [
  'agent.cycle',
  'agent.cyclePrevious',
  'model.pick',
  'model.recentNext',
  'transcript.details',
  'transcript.pageUp',
  'transcript.pageDown',
  'transcript.top',
  'transcript.bottom',
  'transcript.groupPrevious',
  'transcript.groupNext',
  'history.search',
  'composer.stash',
  'composer.editor',
  'composer.newline',
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

export const defaultBindings: Readonly<Record<ActionID, string>> = {
  'agent.cycle': 'shift+tab',
  'agent.cyclePrevious': 'alt+shift+tab',
  'model.pick': 'alt+p',
  'model.recentNext': 'f2',
  'transcript.details': 'ctrl+o',
  'transcript.pageUp': 'pageup',
  'transcript.pageDown': 'pagedown',
  'transcript.top': 'ctrl+home',
  'transcript.bottom': 'ctrl+end',
  'transcript.groupPrevious': 'ctrl+up',
  'transcript.groupNext': 'ctrl+down',
  'history.search': 'ctrl+r',
  'composer.stash': 'ctrl+s',
  'composer.editor': 'ctrl+g',
  'composer.newline': 'ctrl+j',
  'composer.steer': 'ctrl+enter',
  'screen.redraw': 'ctrl+l',
  'tasks.toggle': 'ctrl+t',
  'tools.background': 'ctrl+b',
  'help.show': 'f1',
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

export type Keymap = ReadonlyMap<ActionID, KeyBinding>;

export type KeymapBuild = Readonly<{ keymap: Keymap; errors: readonly string[] }>;

/**
 * Builds the keymap from defaults plus overrides. Invalid or duplicate overrides are
 * reported and the default is kept, so a bad config never leaves an action unbound.
 */
export function buildKeymap(overrides: Readonly<Record<string, string>>): KeymapBuild {
  const errors: string[] = [];
  const keymap = new Map<ActionID, KeyBinding>();
  for (const action of actionIDs) {
    const parsed = parseBinding(defaultBindings[action]);
    if (parsed.ok) keymap.set(action, parsed.binding);
  }
  for (const [action, spec] of Object.entries(overrides)) {
    if (!isActionID(action)) {
      errors.push(`unknown action "${action}"`);
      continue;
    }
    const parsed = parseBinding(spec);
    if (!parsed.ok) {
      errors.push(`${action}: ${parsed.error}`);
      continue;
    }
    const clash = [...keymap.entries()].find(
      ([other, binding]) => other !== action && sameBinding(binding, parsed.binding),
    );
    if (clash !== undefined) {
      errors.push(`${action}: "${spec}" is already bound to ${clash[0]}`);
      continue;
    }
    keymap.set(action, parsed.binding);
  }
  return { keymap, errors };
}

export function actionFor(keymap: Keymap, press: KeyPress): ActionID | undefined {
  for (const [action, binding] of keymap) {
    if (matches(binding, press)) return action;
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
