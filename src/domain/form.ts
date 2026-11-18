/**
 * Agent questions (`session.form`). A form is not a permission: it has no
 * "always" and its answer is a plain key → value map (docs/12).
 */
export type FormOption = Readonly<{ value: string; label: string; description?: string }>;

export type FormCondition = Readonly<{
  key: string;
  op: 'eq' | 'neq';
  value: string | number | boolean;
}>;

type FieldBase = Readonly<{
  key: string;
  title: string;
  description?: string;
  required: boolean;
  when: readonly FormCondition[];
}>;

export type FormField =
  | (FieldBase & { kind: 'text'; placeholder?: string; default?: string })
  | (FieldBase & {
      kind: 'choice';
      options: readonly FormOption[];
      custom: boolean;
      default?: string;
    })
  | (FieldBase & {
      kind: 'multi';
      options: readonly FormOption[];
      minItems?: number;
      maxItems?: number;
      default?: readonly string[];
    })
  | (FieldBase & {
      kind: 'number';
      integer: boolean;
      minimum?: number;
      maximum?: number;
      default?: number;
    })
  | (FieldBase & { kind: 'boolean'; default?: boolean })
  | (FieldBase & { kind: 'external'; url: string });

export type FormRequest = Readonly<{
  id: string;
  sessionID: string;
  title: string;
  fields: readonly FormField[];
}>;

export type FormValue = string | number | boolean | readonly string[];
export type FormAnswers = Readonly<Record<string, FormValue>>;

/** Fields whose `when` conditions hold for the answers so far, in order. */
export function visibleFields(form: FormRequest, answers: FormAnswers): FormField[] {
  return form.fields.filter((field) =>
    field.when.every((condition) => {
      const value = answers[condition.key];
      const equal = value === condition.value;
      return condition.op === 'eq' ? equal : !equal;
    }),
  );
}

/** The starting answer for a field: its default, else empty. */
export function initialValue(field: FormField): FormValue | undefined {
  switch (field.kind) {
    case 'text':
    case 'choice':
    case 'number':
    case 'boolean':
      return field.default;
    case 'multi':
      return field.default ?? [];
    case 'external':
      return undefined;
    default:
      return undefined;
  }
}

/** Parses typed text for a number field; undefined when it is not a valid number. */
export function parseNumber(
  field: FormField & { kind: 'number' },
  text: string,
): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  if (field.integer && !Number.isInteger(value)) return undefined;
  return value;
}

/** A user-facing problem with one field's value, or undefined when it is acceptable. */
export function validateField(field: FormField, value: FormValue | undefined): string | undefined {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) return field.required && field.kind !== 'external' ? 'Required.' : undefined;
  switch (field.kind) {
    case 'number': {
      if (typeof value !== 'number')
        return field.integer ? 'Enter a whole number.' : 'Enter a number.';
      if (field.minimum !== undefined && value < field.minimum) return `At least ${field.minimum}.`;
      if (field.maximum !== undefined && value > field.maximum) return `At most ${field.maximum}.`;
      return undefined;
    }
    case 'choice':
      if (
        !field.custom &&
        typeof value === 'string' &&
        !field.options.some((option) => option.value === value)
      ) {
        return 'Pick one of the options.';
      }
      return undefined;
    case 'multi': {
      const count = Array.isArray(value) ? value.length : 0;
      if (field.minItems !== undefined && count < field.minItems) {
        return `Pick at least ${field.minItems}.`;
      }
      if (field.maxItems !== undefined && count > field.maxItems) {
        return `Pick at most ${field.maxItems}.`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The reply body: only visible, answered, non-external fields. */
export function buildAnswer(form: FormRequest, answers: FormAnswers): Record<string, FormValue> {
  const result: Record<string, FormValue> = {};
  for (const field of visibleFields(form, answers)) {
    if (field.kind === 'external') continue;
    const value = answers[field.key];
    if (value === undefined || value === '') continue;
    result[field.key] = value;
  }
  return result;
}

/** First visible field with a problem, for submit-time validation. */
export function firstInvalid(
  form: FormRequest,
  answers: FormAnswers,
): { index: number; problem: string } | undefined {
  const fields = visibleFields(form, answers);
  for (const [index, field] of fields.entries()) {
    const problem = validateField(field, answers[field.key]);
    if (problem !== undefined) return { index, problem };
  }
  return undefined;
}

/** Multiselect toggle that keeps option order stable. */
export function toggleOption(
  field: FormField & { kind: 'multi' },
  current: readonly string[],
  value: string,
): string[] {
  const chosen = new Set(current);
  if (chosen.has(value)) chosen.delete(value);
  else chosen.add(value);
  return field.options.map((option) => option.value).filter((option) => chosen.has(option));
}

/** In-progress answers for one form, edited one visible field at a time. */
export type FormEditor = Readonly<{
  formID: string;
  index: number;
  answers: FormAnswers;
  /** Typed text for text/number fields (and custom choices). */
  text: string;
  /** Highlighted option for choice/multi/boolean fields. */
  cursor: number;
  problem?: string;
}>;

export type FormKey = Readonly<{ name: string; text?: string; shift: boolean; ctrl: boolean }>;
export type FormOutcome = 'submit' | 'close' | 'decline' | undefined;

export function startEditor(form: FormRequest): FormEditor {
  const answers: Record<string, FormValue> = {};
  for (const field of form.fields) {
    const value = initialValue(field);
    if (value !== undefined) answers[field.key] = value;
  }
  return enterField(form, { formID: form.id, index: 0, answers, text: '', cursor: 0 }, 0);
}

export function currentField(form: FormRequest, editor: FormEditor): FormField | undefined {
  return visibleFields(form, editor.answers)[editor.index];
}

function optionCount(field: FormField): number {
  if (field.kind === 'choice' || field.kind === 'multi') return field.options.length;
  return field.kind === 'boolean' ? 2 : 0;
}

/** Loads the typed text and highlighted option for the field at `index`. */
function enterField(form: FormRequest, editor: FormEditor, index: number): FormEditor {
  const field = visibleFields(form, editor.answers)[index];
  const value = field === undefined ? undefined : editor.answers[field.key];
  let text = '';
  let cursor = 0;
  if (field?.kind === 'text' && typeof value === 'string') text = value;
  if (field?.kind === 'number' && typeof value === 'number') text = String(value);
  if (field?.kind === 'choice' && typeof value === 'string') {
    const found = field.options.findIndex((option) => option.value === value);
    if (found >= 0) cursor = found;
    else if (field.custom) text = value;
  }
  if (field?.kind === 'boolean') cursor = value === false ? 1 : 0;
  return { formID: editor.formID, answers: editor.answers, index, text, cursor };
}

/** Writes the field's typed/highlighted value into the answers. */
function commitField(form: FormRequest, editor: FormEditor): FormEditor {
  const field = currentField(form, editor);
  if (field === undefined) return editor;
  const answers: Record<string, FormValue> = { ...editor.answers };
  switch (field.kind) {
    case 'text':
      answers[field.key] = editor.text;
      break;
    case 'number': {
      const parsed = parseNumber(field, editor.text);
      if (parsed !== undefined) answers[field.key] = parsed;
      else if (editor.text.trim() === '') delete answers[field.key];
      else answers[field.key] = editor.text;
      break;
    }
    case 'choice': {
      const option = field.options[editor.cursor];
      if (field.custom && editor.text !== '') answers[field.key] = editor.text;
      else if (option !== undefined) answers[field.key] = option.value;
      break;
    }
    case 'boolean':
      answers[field.key] = editor.cursor === 0;
      break;
    default:
      break;
  }
  return { ...editor, answers };
}

function advance(
  form: FormRequest,
  editor: FormEditor,
  field: FormField,
): { editor: FormEditor; outcome: FormOutcome } {
  const committed = commitField(form, editor);
  const problem = validateField(field, committed.answers[field.key]);
  if (problem !== undefined) return { editor: { ...committed, problem }, outcome: undefined };
  const fields = visibleFields(form, committed.answers);
  if (committed.index + 1 < fields.length) {
    return { editor: enterField(form, committed, committed.index + 1), outcome: undefined };
  }
  const invalid = firstInvalid(form, committed.answers);
  if (invalid !== undefined) {
    const next = enterField(form, committed, invalid.index);
    return { editor: { ...next, problem: invalid.problem }, outcome: undefined };
  }
  return { editor: committed, outcome: 'submit' };
}

/** Typing and option keys for the current field; navigation is handled by `editorKey`. */
function editField(editor: FormEditor, field: FormField, key: FormKey): FormEditor {
  const count = optionCount(field);
  if (count > 0 && (key.name === 'up' || key.name === 'down')) {
    const step = key.name === 'up' ? -1 : 1;
    return { ...editor, cursor: (editor.cursor + step + count) % count };
  }
  if (field.kind === 'multi') {
    const option = field.options[editor.cursor];
    if (key.name !== 'space' || option === undefined) return editor;
    const current = editor.answers[field.key];
    const chosen = Array.isArray(current) ? current : [];
    return {
      ...editor,
      answers: { ...editor.answers, [field.key]: toggleOption(field, chosen, option.value) },
    };
  }
  if (field.kind === 'boolean') {
    if (key.name === 'space') return { ...editor, cursor: editor.cursor === 0 ? 1 : 0 };
    if (key.text === 'y') return { ...editor, cursor: 0 };
    if (key.text === 'n') return { ...editor, cursor: 1 };
    return editor;
  }
  const typed =
    field.kind === 'text' || field.kind === 'number' || (field.kind === 'choice' && field.custom);
  if (!typed) return editor;
  if (key.name === 'backspace') return { ...editor, text: editor.text.slice(0, -1) };
  if (key.text !== undefined && key.text !== '' && !key.ctrl) {
    return { ...editor, text: editor.text + key.text };
  }
  return editor;
}

/**
 * One key against the form editor. Enter/Tab validates and advances (submitting
 * after the last field), Shift+Tab goes back, Esc closes leaving the form pending,
 * Ctrl+X declines it.
 */
export function editorKey(
  form: FormRequest,
  editor: FormEditor,
  key: FormKey,
): { editor: FormEditor; outcome: FormOutcome } {
  if (key.name === 'escape') return { editor, outcome: 'close' };
  if (key.ctrl && key.name === 'x') return { editor, outcome: 'decline' };
  const field = currentField(form, editor);
  if (field === undefined) return { editor, outcome: 'close' };
  if (key.name === 'return' || (key.name === 'tab' && !key.shift)) {
    return advance(form, editor, field);
  }
  if (key.name === 'tab' && key.shift) {
    const committed = commitField(form, editor);
    return {
      editor: enterField(form, committed, Math.max(0, committed.index - 1)),
      outcome: undefined,
    };
  }
  return { editor: editField(editor, field, key), outcome: undefined };
}
