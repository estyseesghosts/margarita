/**
 * Agent questions (`session.form`). A form is not a permission: it has no
 * "always" and its answer is a plain key → value map (docs/12).
 */
import {
  type Composer,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  insertText,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
} from './composer.ts';

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
  /** Protocol-hidden fields are never prompts; their server-provided defaults still reply. */
  hidden: boolean;
  when: readonly FormCondition[];
}>;

type StringConstraints = Readonly<{
  format?: 'email' | 'uri' | 'date' | 'date-time';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}>;

export type FormField =
  | (FieldBase & { kind: 'text'; placeholder?: string; default?: string } & StringConstraints)
  | (FieldBase & {
      kind: 'choice';
      options: readonly FormOption[];
      custom: boolean;
      default?: string;
    } & StringConstraints)
  | (FieldBase & {
      kind: 'multi';
      options: readonly FormOption[];
      /** Whether arbitrary values may be added alongside the listed options. */
      custom: boolean;
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

/** Whether a field's `when` conditions hold for the answers so far. */
function conditionsHold(field: FormField, answers: FormAnswers): boolean {
  return field.when.every((condition) => {
    const value = answers[condition.key];
    const equal = value === condition.value;
    return condition.op === 'eq' ? equal : !equal;
  });
}

/** Fields whose `when` conditions hold and which the user may actually edit, in order. */
export function visibleFields(form: FormRequest, answers: FormAnswers): FormField[] {
  return form.fields.filter((field) => !field.hidden && conditionsHold(field, answers));
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
    case 'text':
    case 'choice': {
      if (field.kind === 'choice' && !field.custom && typeof value === 'string') {
        if (!field.options.some((option) => option.value === value)) {
          return 'Pick one of the options.';
        }
      }
      return typeof value === 'string' ? validateString(field, value) : undefined;
    }
    case 'number': {
      if (typeof value !== 'number')
        return field.integer ? 'Enter a whole number.' : 'Enter a number.';
      if (field.minimum !== undefined && value < field.minimum) return `At least ${field.minimum}.`;
      if (field.maximum !== undefined && value > field.maximum) return `At most ${field.maximum}.`;
      return undefined;
    }
    case 'multi': {
      const values = Array.isArray(value) ? value : [];
      const count = values.length;
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

/**
 * Applies the v2 string constraints locally so an avoidable round trip never reaches
 * `session.form.reply`. The server remains the final authority; an unsupported or
 * malformed pattern is ignored rather than making every answer impossible (#211).
 */
function validateString(
  field: FormField & { kind: 'text' | 'choice' },
  value: string,
): string | undefined {
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `Must be at least ${field.minLength} character${field.minLength === 1 ? '' : 's'}.`;
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `Must be at most ${field.maxLength} character${field.maxLength === 1 ? '' : 's'}.`;
  }
  if (field.pattern !== undefined) {
    try {
      if (!new RegExp(field.pattern).test(value)) return 'Does not match the requested format.';
    } catch {
      // An unsupported pattern is the server's problem; do not block a plausible answer.
    }
  }
  switch (field.format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? undefined : 'Enter an email address.';
    case 'uri':
      return isUri(value) ? undefined : 'Enter a URI.';
    case 'date':
      return isValidDate(value, false) ? undefined : 'Enter a date (YYYY-MM-DD).';
    case 'date-time':
      return isValidDate(value, true) ? undefined : 'Enter a date and time.';
    default:
      return undefined;
  }
}

function isUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol !== '' && value.includes(':');
  } catch {
    return false;
  }
}

function isValidDate(value: string, withTime: boolean): boolean {
  if (withTime) return !Number.isNaN(Date.parse(value)) && value.includes('T');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-').map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 0;
  const day = parts[2] ?? 0;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The reply body: visible answered fields, plus hidden server defaults. */
export function buildAnswer(form: FormRequest, answers: FormAnswers): Record<string, FormValue> {
  const result: Record<string, FormValue> = {};
  for (const field of form.fields) {
    if (field.kind === 'external') continue;
    if (field.hidden) {
      // Hidden fields are protocol values, not prompts. Include only what the server
      // itself supplied as a default (initialValue); never invent a value.
      const value = answers[field.key];
      if (value !== undefined && value !== '') result[field.key] = value;
      continue;
    }
    if (!conditionsHold(field, answers)) continue;
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

/** Multiselect toggle that keeps listed and custom values in stable order. */
export function toggleOption(
  field: FormField & { kind: 'multi' },
  current: readonly string[],
  value: string,
): string[] {
  const chosen = new Set(current);
  if (chosen.has(value)) chosen.delete(value);
  else chosen.add(value);
  const listed = field.options.map((option) => option.value).filter((entry) => chosen.has(entry));
  // Preserve custom values (already chosen but not listed) in their original order.
  const custom = current.filter(
    (entry) => !field.options.some((option) => option.value === entry) && chosen.has(entry),
  );
  return [...listed, ...custom];
}

/**
 * Bounded window of choices around the highlighted row (#245). Long choice lists must not
 * grow the dialog past the terminal; the selected option always remains visible.
 */
export function choiceWindow(
  cursor: number,
  count: number,
  rows: number,
): { start: number; end: number } {
  const total = Math.max(0, count);
  const size = Math.min(total, Math.max(1, rows));
  if (size === 0) return { start: 0, end: 0 };
  const selected = Math.max(0, Math.min(total - 1, cursor));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
  return { start, end: start + size };
}

/** All selectable multi values: predefined options then custom values still chosen. */
export function multiChoices(
  field: FormField & { kind: 'multi' },
  current: readonly string[] | undefined,
): { value: string; label: string; custom: boolean }[] {
  const chosen = Array.isArray(current) ? current : [];
  const listed = field.options.map((option) => ({
    value: option.value,
    label: option.label,
    custom: false,
  }));
  const custom = chosen
    .filter((value) => !field.options.some((option) => option.value === value))
    .map((value) => ({ value, label: value, custom: true }));
  return [...listed, ...custom];
}

/** In-progress answers for one form, edited one visible field at a time. */
export type FormEditor = Readonly<{
  formID: string;
  index: number;
  answers: FormAnswers;
  /** Typed text for text/number fields (and the saved custom draft of a choice). */
  text: string;
  /** Grapheme-safe caret in `text` (#232). */
  textCursor: number;
  /** Highlighted option for choice/multi/boolean fields. */
  cursor: number;
  /**
   * Whether the current single-choice field commits its custom draft instead of the
   * highlighted listed option (#265). Browsing options never destroys the draft.
   */
  choiceCustom: boolean;
  /**
   * Which part of a custom-enabled single-choice field owns the keyboard (#269): the listed
   * options or the custom text caret. Kept separate from `choiceCustom`, which is the value
   * Enter will commit; switching focus to custom also selects custom as the commit source.
   */
  choiceFocus: 'list' | 'custom';
  /** Per-choice-field custom draft, active source and focus, restored when navigating back. */
  choiceDrafts: Readonly<
    Record<
      string,
      Readonly<{ text: string; cursor: number; custom: boolean; focus: 'list' | 'custom' }>
    >
  >;
  /** In-progress custom multiselect value; `addingCustom` opens the entry row. */
  customDraft?: string | undefined;
  /** Grapheme-safe caret in `customDraft` (#232). */
  customCursor: number;
  /** Last caret per text-like field key, restored when navigating back (#232). */
  carets: Readonly<Record<string, number>>;
  addingCustom?: boolean | undefined;
  problem?: string | undefined;
}>;

export type FormKey = Readonly<{ name: string; text?: string; shift: boolean; ctrl: boolean }>;
export type FormOutcome = 'submit' | 'close' | 'decline' | undefined;

export function startEditor(form: FormRequest): FormEditor {
  const answers: Record<string, FormValue> = {};
  for (const field of form.fields) {
    const value = initialValue(field);
    if (value !== undefined) answers[field.key] = value;
  }
  return enterField(
    form,
    {
      formID: form.id,
      index: 0,
      answers,
      text: '',
      textCursor: 0,
      cursor: 0,
      choiceCustom: false,
      choiceFocus: 'list',
      choiceDrafts: {},
      customCursor: 0,
      carets: {},
    },
    0,
  );
}

export function currentField(form: FormRequest, editor: FormEditor): FormField | undefined {
  return visibleFields(form, editor.answers)[editor.index];
}

/**
 * User-facing fields in the form's initial state, using the same hidden/`when` rules as the
 * editor. Pending cards must not count protocol-hidden fields (#235).
 */
export function initialVisibleFields(form: FormRequest): FormField[] {
  const answers: Record<string, FormValue> = {};
  for (const field of form.fields) {
    const value = initialValue(field);
    if (value !== undefined) answers[field.key] = value;
  }
  return visibleFields(form, answers);
}

function optionCount(field: FormField, answers: FormAnswers): number {
  if (field.kind === 'choice') return field.options.length;
  if (field.kind === 'multi') {
    const current = answers[field.key];
    return multiChoices(field, Array.isArray(current) ? current : []).length;
  }
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
  let choiceCustom = false;
  let choiceFocus: 'list' | 'custom' = 'list';
  if (field?.kind === 'choice' && typeof value === 'string') {
    const found = field.options.findIndex((option) => option.value === value);
    if (found >= 0) cursor = found;
    else if (field.custom) {
      text = value;
      choiceCustom = true;
      choiceFocus = 'custom';
    }
  }
  // A custom draft typed before browsing listed options survives the round trip (#265).
  const draft =
    field?.kind === 'choice' && field.custom ? editor.choiceDrafts[field.key] : undefined;
  if (draft !== undefined) {
    text = draft.text;
    cursor = draft.custom
      ? cursor
      : Math.max(
          0,
          field?.kind === 'choice'
            ? field.options.findIndex((option) => option.value === value)
            : 0,
        );
    choiceCustom = draft.custom;
    choiceFocus = draft.focus;
  }
  if (field?.kind === 'boolean') cursor = value === false ? 1 : 0;
  const saved = draft === undefined && field !== undefined ? editor.carets[field.key] : undefined;
  const textCursor =
    draft !== undefined
      ? Math.min(draft.cursor, text.length)
      : saved === undefined
        ? text.length
        : Math.min(saved, text.length);
  return {
    formID: editor.formID,
    answers: editor.answers,
    index,
    text,
    textCursor,
    cursor,
    choiceCustom,
    choiceFocus,
    choiceDrafts: editor.choiceDrafts,
    customCursor: 0,
    carets: editor.carets,
  };
}

/** Records the outgoing text-like field's caret before navigation (#232). */
function rememberCaret(form: FormRequest, editor: FormEditor): FormEditor {
  const field = currentField(form, editor);
  if (
    field === undefined ||
    (field.kind !== 'text' && field.kind !== 'number' && !(field.kind === 'choice' && field.custom))
  ) {
    return editor;
  }
  const next = {
    ...editor,
    carets: { ...editor.carets, [field.key]: editor.textCursor },
  };
  if (field.kind !== 'choice') return next;
  // Browsing listed options must be reversible: keep the custom draft, its caret and which
  // source was active, so returning to custom entry restores exactly what was typed (#265).
  return {
    ...next,
    choiceDrafts: {
      ...editor.choiceDrafts,
      [field.key]: {
        text: editor.text,
        cursor: editor.textCursor,
        custom: editor.choiceCustom,
        focus: editor.choiceFocus,
      },
    },
  };
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
      // The active source decides the answer. A saved draft is not a selection just
      // because it contains text (#255, #265).
      if (field.custom && editor.choiceCustom) {
        if (editor.text !== '') answers[field.key] = editor.text;
        else delete answers[field.key];
      } else if (option !== undefined) answers[field.key] = option.value;
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
  const committed = commitField(form, rememberCaret(form, editor));
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
  const count = optionCount(field, editor.answers);
  if (field.kind === 'multi' && field.custom && editor.addingCustom === true) {
    const draft: Composer = { text: editor.customDraft ?? '', cursor: editor.customCursor };
    const setDraft = (next: Composer): FormEditor => ({
      ...editor,
      customDraft: next.text,
      customCursor: next.cursor,
    });
    if (key.name === 'escape')
      return { ...editor, addingCustom: false, customDraft: '', customCursor: 0 };
    if (key.name === 'return') {
      const value = (editor.customDraft ?? '').trim();
      if (value === '') return { ...editor, addingCustom: false, customDraft: '', customCursor: 0 };
      const current = editor.answers[field.key];
      const chosen = Array.isArray(current) ? current : [];
      if (chosen.includes(value)) {
        return {
          ...editor,
          addingCustom: false,
          customDraft: '',
          customCursor: 0,
          problem: 'Already chosen.',
        };
      }
      return {
        ...editor,
        answers: { ...editor.answers, [field.key]: [...chosen, value] },
        addingCustom: false,
        customDraft: '',
        customCursor: 0,
      };
    }
    if (key.name === 'left') return setDraft(key.ctrl ? moveWordLeft(draft) : moveLeft(draft));
    if (key.name === 'right') return setDraft(key.ctrl ? moveWordRight(draft) : moveRight(draft));
    if (key.name === 'home') return setDraft(moveLineStart(draft));
    if (key.name === 'end') return setDraft(moveLineEnd(draft));
    if (key.name === 'backspace')
      return setDraft(key.ctrl ? deleteWordBackward(draft) : deleteBackward(draft));
    if (key.name === 'delete')
      return setDraft(key.ctrl ? deleteWordForward(draft) : deleteForward(draft));
    if (key.text !== undefined && key.text !== '' && !key.ctrl) {
      return setDraft(insertText(draft, key.text));
    }
    return editor;
  }
  const customChoice = field.kind === 'choice' && field.custom;
  if (customChoice && editor.choiceFocus === 'custom') {
    if (key.ctrl && key.name === 'e') {
      return { ...editor, choiceFocus: 'list', choiceCustom: false, problem: undefined };
    }
    // Up/Down are a deliberate return to the list, not caret movement; Home/End stay in the
    // text editor while custom input owns the keyboard (#269).
    if (
      key.name === 'up' ||
      key.name === 'down' ||
      key.name === 'pageup' ||
      key.name === 'pagedown'
    ) {
      const step =
        key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'pageup' ? -10 : 10;
      return {
        ...editor,
        cursor: (editor.cursor + step + count) % count,
        choiceFocus: 'list',
        choiceCustom: false,
        problem: undefined,
      };
    }
    return editChoiceText(editor, key);
  }
  if (
    count > 0 &&
    (key.name === 'up' ||
      key.name === 'down' ||
      key.name === 'pageup' ||
      key.name === 'pagedown' ||
      key.name === 'home' ||
      key.name === 'end')
  ) {
    // Moving onto a listed choice is an explicit selection, but browsing must not destroy
    // the custom draft. Only the commit source changes; the saved text stays available
    // when the user returns to custom entry (#255, #265).
    const step =
      key.name === 'up'
        ? -1
        : key.name === 'down'
          ? 1
          : key.name === 'pageup'
            ? -10
            : key.name === 'pagedown'
              ? 10
              : 0;
    const next =
      key.name === 'home'
        ? 0
        : key.name === 'end'
          ? count - 1
          : (editor.cursor + step + count) % count;
    return {
      ...editor,
      cursor: next,
      ...(field.kind === 'choice' ? { choiceCustom: false, choiceFocus: 'list' as const } : {}),
    };
  }
  if (customChoice) {
    // The list owns the keyboard: only an explicit edit action enters custom text. Typing a
    // character is explicit; movement keys never silently flip the committed source (#269).
    if (key.ctrl && key.name === 'e') {
      return { ...editor, choiceFocus: 'custom', choiceCustom: true, problem: undefined };
    }
    if (key.text !== undefined && key.text !== '' && !key.ctrl) {
      return editChoiceText(
        { ...editor, choiceFocus: 'custom', choiceCustom: true, problem: undefined },
        key,
      );
    }
    return editor;
  }
  if (field.kind === 'multi') {
    if (field.custom && key.text === 'a' && !key.ctrl) {
      return { ...editor, addingCustom: true, customDraft: '', customCursor: 0 };
    }
    const current = editor.answers[field.key];
    const chosen = Array.isArray(current) ? current : [];
    const choices = multiChoices(field, chosen);
    const choice = choices[editor.cursor];
    if (field.custom && choice?.custom === true && (key.name === 'x' || key.name === 'delete')) {
      return {
        ...editor,
        answers: {
          ...editor.answers,
          [field.key]: chosen.filter((value) => value !== choice.value),
        },
        cursor: Math.max(0, editor.cursor - 1),
      };
    }
    if (key.name !== 'space' || choice === undefined) return editor;
    return {
      ...editor,
      answers: { ...editor.answers, [field.key]: toggleOption(field, chosen, choice.value) },
    };
  }
  if (field.kind === 'boolean') {
    if (key.name === 'space') return { ...editor, cursor: editor.cursor === 0 ? 1 : 0 };
    if (key.text === 'y') return { ...editor, cursor: 0 };
    if (key.text === 'n') return { ...editor, cursor: 1 };
    return editor;
  }
  const typed = field.kind === 'text' || field.kind === 'number';
  if (!typed) return editor;
  const buffer: Composer = { text: editor.text, cursor: editor.textCursor };
  const setText = (next: Composer): FormEditor => ({
    ...editor,
    text: next.text,
    textCursor: next.cursor,
    problem: undefined,
  });
  if (key.name === 'left') return setText(key.ctrl ? moveWordLeft(buffer) : moveLeft(buffer));
  if (key.name === 'right') return setText(key.ctrl ? moveWordRight(buffer) : moveRight(buffer));
  if (key.name === 'home') return setText(moveLineStart(buffer));
  if (key.name === 'end') return setText(moveLineEnd(buffer));
  if (key.name === 'backspace')
    return setText(key.ctrl ? deleteWordBackward(buffer) : deleteBackward(buffer));
  if (key.name === 'delete')
    return setText(key.ctrl ? deleteWordForward(buffer) : deleteForward(buffer));
  if (key.text !== undefined && key.text !== '' && !key.ctrl) {
    return setText(insertText(buffer, key.text));
  }
  return editor;
}

/** Caret/text editing for a custom single-choice value; focus and source stay custom. */
function editChoiceText(editor: FormEditor, key: FormKey): FormEditor {
  const buffer: Composer = { text: editor.text, cursor: editor.textCursor };
  const setText = (next: Composer): FormEditor => ({
    ...editor,
    text: next.text,
    textCursor: next.cursor,
    choiceFocus: 'custom',
    choiceCustom: true,
    problem: undefined,
  });
  if (key.name === 'left') return setText(key.ctrl ? moveWordLeft(buffer) : moveLeft(buffer));
  if (key.name === 'right') return setText(key.ctrl ? moveWordRight(buffer) : moveRight(buffer));
  if (key.name === 'home') return setText(moveLineStart(buffer));
  if (key.name === 'end') return setText(moveLineEnd(buffer));
  if (key.name === 'backspace')
    return setText(key.ctrl ? deleteWordBackward(buffer) : deleteBackward(buffer));
  if (key.name === 'delete')
    return setText(key.ctrl ? deleteWordForward(buffer) : deleteForward(buffer));
  if (key.text !== undefined && key.text !== '' && !key.ctrl) {
    return setText(insertText(buffer, key.text));
  }
  return editor;
}

/**
 * Inserts one pasted-text transaction into the active text-like field. Never interprets
 * newlines or shortcut-looking text as keys, and never touches another field or session.
 */
export function pasteFormText(
  form: FormRequest,
  editor: FormEditor,
  text: string,
): { editor: FormEditor; error?: string } {
  const field = currentField(form, editor);
  if (field === undefined) return { editor, error: 'No field is selected.' };
  if (field.kind === 'multi' && field.custom && editor.addingCustom === true) {
    const next = insertText({ text: editor.customDraft ?? '', cursor: editor.customCursor }, text);
    return { editor: { ...editor, customDraft: next.text, customCursor: next.cursor } };
  }
  if (
    field.kind === 'text' ||
    field.kind === 'number' ||
    (field.kind === 'choice' && field.custom)
  ) {
    const next = insertText({ text: editor.text, cursor: editor.textCursor }, text);
    return {
      editor: {
        ...editor,
        text: next.text,
        textCursor: next.cursor,
        ...(field.kind === 'choice' ? { choiceCustom: true, choiceFocus: 'custom' as const } : {}),
        problem: undefined,
      },
    };
  }
  if (field.kind === 'multi' && field.custom) {
    return {
      editor: { ...editor, addingCustom: true, customDraft: text, customCursor: text.length },
    };
  }
  const reason =
    field.kind === 'external'
      ? 'Open external prompts in a browser.'
      : 'This field does not accept text.';
  return { editor, error: reason };
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
  if (key.ctrl && key.name === 'x') return { editor, outcome: 'decline' };
  const field = currentField(form, editor);
  if (field === undefined) return { editor, outcome: 'close' };
  // A custom multiselect entry owns typing/Enter/Esc until it is added or cancelled.
  if (editor.addingCustom === true && field.kind === 'multi') {
    return { editor: editField(editor, field, key), outcome: undefined };
  }
  if (key.name === 'escape') return { editor, outcome: 'close' };
  if (key.name === 'return' || (key.name === 'tab' && !key.shift)) {
    return advance(form, editor, field);
  }
  if (key.name === 'tab' && key.shift) {
    const committed = commitField(form, rememberCaret(form, editor));
    return {
      editor: enterField(form, committed, Math.max(0, committed.index - 1)),
      outcome: undefined,
    };
  }
  return { editor: editField(editor, field, key), outcome: undefined };
}
