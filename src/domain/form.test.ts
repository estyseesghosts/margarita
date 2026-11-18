import { describe, expect, test } from 'bun:test';

import {
  buildAnswer,
  currentField,
  editorKey,
  firstInvalid,
  type FormField,
  type FormRequest,
  parseNumber,
  startEditor,
  toggleOption,
  validateField,
  visibleFields,
} from './form.ts';

const base = { required: false, when: [] };

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
});
