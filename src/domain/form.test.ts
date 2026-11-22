import { describe, expect, test } from 'bun:test';

import {
  buildAnswer,
  currentField,
  editorKey,
  firstInvalid,
  type FormField,
  type FormRequest,
  multiChoices,
  parseNumber,
  pasteFormText,
  startEditor,
  toggleOption,
  validateField,
  visibleFields,
} from './form.ts';

const base = { required: false, hidden: false, when: [] };

function press(name: string, text?: string) {
  return { name, shift: false, ctrl: false, ...(text === undefined ? {} : { text }) };
}

const form: FormRequest = {
  id: 'frm_1',
  sessionID: 'ses_a',
  title: 'Deploy target',
  fields: [
    {
      ...base,
      key: 'env',
      title: 'Environment',
      kind: 'choice',
      required: true,
      custom: false,
      options: [
        { value: 'staging', label: 'Staging' },
        { value: 'prod', label: 'Production' },
      ],
    },
    {
      ...base,
      key: 'reason',
      title: 'Why production?',
      kind: 'text',
      required: true,
      when: [{ key: 'env', op: 'eq', value: 'prod' }],
    },
    { ...base, key: 'docs', title: 'Runbook', kind: 'external', url: 'https://example.test/rb' },
  ],
};

describe('forms', () => {
  test('conditional fields appear only when their condition holds', () => {
    expect(visibleFields(form, {}).map((field) => field.key)).toEqual(['env', 'docs']);
    expect(visibleFields(form, { env: 'prod' }).map((field) => field.key)).toEqual([
      'env',
      'reason',
      'docs',
    ]);
  });

  test('validation reports the first invalid visible field', () => {
    expect(firstInvalid(form, {})).toEqual({ index: 0, problem: 'Required.' });
    expect(firstInvalid(form, { env: 'qa' })?.problem).toBe('Pick one of the options.');
    expect(firstInvalid(form, { env: 'prod' })).toEqual({ index: 1, problem: 'Required.' });
    expect(firstInvalid(form, { env: 'prod', reason: 'hotfix' })).toBeUndefined();
  });

  test('answers include only visible, answered, non-external fields', () => {
    expect(buildAnswer(form, { env: 'staging', reason: 'stale' })).toEqual({ env: 'staging' });
    expect(buildAnswer(form, { env: 'prod', reason: 'hotfix' })).toEqual({
      env: 'prod',
      reason: 'hotfix',
    });
  });

  test('numbers respect integer and range constraints', () => {
    const field: FormField & { kind: 'number' } = {
      ...base,
      key: 'n',
      title: 'Count',
      kind: 'number',
      integer: true,
      minimum: 1,
      maximum: 5,
    };
    expect(parseNumber(field, '3')).toBe(3);
    expect(parseNumber(field, '2.5')).toBeUndefined();
    expect(parseNumber(field, 'x')).toBeUndefined();
    expect(validateField(field, 9)).toBe('At most 5.');
    expect(validateField(field, '3')).toBe('Enter a whole number.');
  });

  test('editor walks visible fields, reveals conditional ones and submits', () => {
    let editor = startEditor(form);
    editor = editorKey(form, editor, press('down')).editor;
    editor = editorKey(form, editor, press('return')).editor;
    expect(editor.answers['env']).toBe('prod');
    expect(currentField(form, editor)?.key).toBe('reason');

    const blocked = editorKey(form, editor, press('return'));
    expect(blocked.editor.problem).toBe('Required.');
    editor = blocked.editor;
    for (const char of ['h', 'o', 't']) editor = editorKey(form, editor, press(char, char)).editor;
    editor = editorKey(form, editor, press('return')).editor;
    expect(currentField(form, editor)?.key).toBe('docs');
    const done = editorKey(form, editor, press('return'));
    expect(done.outcome).toBe('submit');
    expect(buildAnswer(form, done.editor.answers)).toEqual({ env: 'prod', reason: 'hot' });
  });

  test('editor: Esc closes, Ctrl+X declines', () => {
    const editor = startEditor(form);
    expect(editorKey(form, editor, press('escape')).outcome).toBe('close');
    expect(editorKey(form, editor, { name: 'x', shift: false, ctrl: true }).outcome).toBe(
      'decline',
    );
  });

  test('multiselect toggles keep option order and enforce limits', () => {
    const field: FormField & { kind: 'multi' } = {
      ...base,
      key: 'm',
      title: 'Pick',
      kind: 'multi',
      custom: false,
      maxItems: 1,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    };
    expect(toggleOption(field, ['b'], 'a')).toEqual(['a', 'b']);
    expect(toggleOption(field, ['a', 'b'], 'a')).toEqual(['b']);
    expect(validateField(field, ['a', 'b'])).toBe('Pick at most 1.');
  });

  test('string constraints are validated locally with actionable messages (#211)', () => {
    const email: FormField & { kind: 'text' } = {
      ...base,
      key: 'email',
      title: 'Email',
      kind: 'text',
      required: true,
      format: 'email',
      minLength: 6,
      maxLength: 40,
      pattern: '^[^@]+@',
    };
    expect(validateField(email, 'x')).toBe('Must be at least 6 characters.');
    expect(validateField(email, 'xxxxx@y')).toBe('Enter an email address.');
    expect(validateField(email, 'user@example.test')).toBeUndefined();
    expect(validateField({ ...email, pattern: '(' }, 'user@example.test')).toBeUndefined();
    expect(validateField({ ...email, pattern: '.*', format: 'date' }, '2026-02-30')).toBe(
      'Enter a date (YYYY-MM-DD).',
    );
    expect(
      validateField({ ...email, pattern: '.*', format: 'date' }, '2026-11-22'),
    ).toBeUndefined();
  });

  test('hidden fields never render but server defaults still reach the reply (#212)', () => {
    const hiddenForm: FormRequest = {
      ...form,
      fields: [
        ...form.fields,
        {
          ...base,
          key: 'token',
          title: 'Internal',
          kind: 'text',
          hidden: true,
          default: 'server-value',
        },
      ],
    };
    expect(visibleFields(hiddenForm, {}).map((field) => field.key)).toEqual(['env', 'docs']);
    const editor = startEditor(hiddenForm);
    expect(buildAnswer(hiddenForm, { ...editor.answers, env: 'staging' })).toEqual({
      env: 'staging',
      token: 'server-value',
    });
  });

  test('custom multiselect values can be added, preserved and removed (#212)', () => {
    const field: FormField & { kind: 'multi' } = {
      ...base,
      key: 'tags',
      title: 'Tags',
      kind: 'multi',
      custom: true,
      options: [{ value: 'a', label: 'A' }],
    };
    const customForm: FormRequest = { ...form, fields: [field] };
    let editor = startEditor(customForm);
    editor = editorKey(customForm, editor, press('a', 'a')).editor;
    expect(editor.addingCustom).toBe(true);
    for (const char of ['x', 'y']) editor = editorKey(customForm, editor, press(char, char)).editor;
    editor = editorKey(customForm, editor, press('return')).editor;
    expect(editor.answers['tags']).toEqual(['xy']);
    expect(multiChoices(field, ['a', 'xy']).map((choice) => choice.value)).toEqual(['a', 'xy']);
    editor = { ...editor, cursor: 1 };
    editor = editorKey(customForm, editor, press('x', 'x')).editor;
    expect(editor.answers['tags']).toEqual([]);
  });

  test('pasting into a question edits only the active text-like field (#210)', () => {
    const textForm: FormRequest = {
      ...form,
      fields: [{ ...base, key: 'answer', title: 'Answer', kind: 'text', required: true }],
    };
    const editor = startEditor(textForm);
    const pasted = pasteFormText(textForm, editor, 'first\nsecond');
    expect(pasted.error).toBeUndefined();
    expect(pasted.editor.text).toBe('first\nsecond');
    const docs = { ...startEditor(form), index: 1 };
    expect(pasteFormText(form, docs, 'nope').error).toContain('browser');
  });
});
