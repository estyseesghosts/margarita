import { describe, expect, test } from 'bun:test';

import {
  buildAnswer,
  choiceWindow,
  currentField,
  editorKey,
  firstInvalid,
  type FormField,
  type FormRequest,
  initialVisibleFields,
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

  test('long choice lists use a bounded window that always includes the cursor (#245)', () => {
    expect(choiceWindow(0, 50, 10)).toEqual({ start: 0, end: 10 });
    expect(choiceWindow(25, 50, 10)).toEqual({ start: 20, end: 30 });
    expect(choiceWindow(49, 50, 10)).toEqual({ start: 40, end: 50 });
    expect(choiceWindow(7, 4, 10)).toEqual({ start: 0, end: 4 });
    expect(choiceWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  test('Home/End and PageUp/PageDown navigate a long choice field (#245)', () => {
    const options = Array.from({ length: 30 }, (_, index) => ({
      value: `v${index}`,
      label: `Option ${index}`,
    }));
    const longForm: FormRequest = {
      ...form,
      fields: [
        { ...base, key: 'env', title: 'Environment', kind: 'choice', custom: false, options },
      ],
    };
    let editor = startEditor(longForm);
    expect(editor.cursor).toBe(0);
    editor = editorKey(longForm, editor, press('end')).editor;
    expect(editor.cursor).toBe(29);
    editor = editorKey(longForm, editor, press('pageup')).editor;
    expect(editor.cursor).toBe(19);
    editor = editorKey(longForm, editor, press('home')).editor;
    expect(editor.cursor).toBe(0);
    editor = editorKey(longForm, editor, press('pagedown')).editor;
    expect(editor.cursor).toBe(10);
    editor = editorKey(longForm, editor, press('return')).editor;
    expect(editor.answers['env']).toBe('v10');
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

  test('initial visible fields exclude hidden and unmet conditional fields (#235)', () => {
    expect(form.fields).toHaveLength(3);
    // `reason` is conditional on env=prod and `env` starts empty, so the initial dialog is
    // the choice plus the external runbook; the card must count the same two.
    expect(initialVisibleFields(form).map((field) => field.key)).toEqual(['env', 'docs']);
    const hidden = {
      ...form,
      fields: [
        ...form.fields,
        { ...base, key: 'token', title: 'Internal', kind: 'text' as const, hidden: true },
      ],
    };
    expect(initialVisibleFields(hidden).map((field) => field.key)).toEqual(['env', 'docs']);
    expect(
      initialVisibleFields({
        ...form,
        fields: form.fields.map((field) => ({ ...field, hidden: true })),
      }),
    ).toEqual([]);
  });

  test('typed fields edit at a grapheme-safe cursor (#232)', () => {
    const textForm: FormRequest = {
      ...form,
      fields: [{ ...base, key: 'note', title: 'Note', kind: 'text', required: false }],
    };
    let editor = startEditor(textForm);
    for (const character of 'abcd') {
      editor = editorKey(textForm, editor, press('letter', character)).editor;
    }
    expect(editor.textCursor).toBe(4);
    editor = editorKey(textForm, editor, press('left')).editor;
    editor = editorKey(textForm, editor, press('left')).editor;
    expect(editor.textCursor).toBe(2);
    editor = editorKey(textForm, editor, press('letter', 'X')).editor;
    expect(editor.text).toBe('abXcd');
    expect(editor.textCursor).toBe(3);
    editor = editorKey(textForm, editor, press('backspace')).editor;
    expect(editor.text).toBe('abcd');
    expect(editor.textCursor).toBe(2);
    editor = editorKey(textForm, editor, press('delete')).editor;
    expect(editor.text).toBe('abd');
    editor = editorKey(textForm, editor, press('home')).editor;
    expect(editor.textCursor).toBe(0);
    editor = editorKey(textForm, editor, press('end')).editor;
    expect(editor.textCursor).toBe(3);

    // Emoji join sequences delete as one grapheme, never a lone surrogate.
    let emoji = startEditor(textForm);
    for (const character of 'ab') {
      emoji = editorKey(textForm, emoji, press('letter', character)).editor;
    }
    emoji = editorKey(textForm, emoji, press('left')).editor;
    emoji = editorKey(textForm, emoji, press('left')).editor;
    emoji = editorKey(textForm, emoji, press('emoji', '👩‍💻')).editor;
    expect(emoji.text).toBe('👩‍💻ab');
    emoji = editorKey(textForm, emoji, press('backspace')).editor;
    expect(emoji.text).toBe('ab');
    expect(emoji.textCursor).toBe(0);
  });

  test('number and custom-choice text edit in the middle (#232)', () => {
    const numberForm: FormRequest = {
      ...form,
      fields: [
        { ...base, key: 'count', title: 'Count', kind: 'number', integer: false, required: false },
      ],
    };
    let number = startEditor(numberForm);
    number = editorKey(numberForm, number, press('digit', '1')).editor;
    number = editorKey(numberForm, number, press('digit', '2')).editor;
    number = editorKey(numberForm, number, press('left')).editor;
    number = editorKey(numberForm, number, press('digit', '3')).editor;
    expect(number.text).toBe('132');
    const committed = editorKey(numberForm, number, press('return'));
    expect(committed.outcome).toBe('submit');
    expect(committed.editor.answers['count']).toBe(132);

    const customForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [{ value: 'main', label: 'main' }],
        },
      ],
    };
    let custom = startEditor(customForm);
    for (const character of 'feature') {
      custom = editorKey(customForm, custom, press('letter', character)).editor;
    }
    custom = editorKey(customForm, custom, press('left')).editor;
    custom = editorKey(customForm, custom, press('letter', 'X')).editor;
    expect(custom.text).toBe('featurXe');
  });

  test('selecting a listed option overrides stale custom-choice text (#255)', () => {
    const choiceForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'release', label: 'release' },
          ],
        },
      ],
    };
    let editor = startEditor(choiceForm);
    for (const character of 'feature') {
      editor = editorKey(choiceForm, editor, press('letter', character)).editor;
    }
    expect(editor.text).toBe('feature');
    editor = editorKey(choiceForm, editor, press('down')).editor;
    // Browsing must not destroy the draft; only the active commit source changes (#265).
    expect(editor.text).toBe('feature');
    expect(editor.choiceCustom).toBe(false);
    editor = editorKey(choiceForm, editor, press('return')).editor;
    expect(editor.answers['branch']).toBe('release');
  });

  test('custom → listed → custom restores draft, caret and the typed answer (#265)', () => {
    const choiceForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'develop', label: 'develop' },
          ],
        },
      ],
    };
    let editor = startEditor(choiceForm);
    for (const character of 'feature/some-long-branch') {
      editor = editorKey(choiceForm, editor, press('letter', character)).editor;
    }
    expect(editor.choiceCustom).toBe(true);
    expect(editor.choiceFocus).toBe('custom');
    expect(editor.textCursor).toBe('feature/some-long-branch'.length);
    editor = editorKey(choiceForm, editor, press('left')).editor;
    editor = editorKey(choiceForm, editor, press('left')).editor;
    // Browse the listed options: the draft and its caret survive.
    editor = editorKey(choiceForm, editor, press('down')).editor;
    editor = editorKey(choiceForm, editor, press('down')).editor;
    expect(editor.text).toBe('feature/some-long-branch');
    expect(editor.textCursor).toBe('feature/some-long-branch'.length - 2);
    expect(editor.choiceCustom).toBe(false);
    expect(editor.choiceFocus).toBe('list');
    // Returning to custom entry restores it, and an edit resumes exactly at the caret.
    editor = editorKey(choiceForm, editor, press('up')).editor;
    editor = editorKey(choiceForm, editor, press('up')).editor;
    editor = editorKey(choiceForm, editor, press('letter', 'X')).editor;
    expect(editor.choiceCustom).toBe(true);
    expect(editor.text).toBe('feature/some-long-branXch');
    editor = editorKey(choiceForm, editor, press('return')).editor;
    expect(editor.answers['branch']).toBe('feature/some-long-branXch');
  });

  test('listed → custom → listed submits the visible listed option (#255, #265)', () => {
    const choiceForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'develop', label: 'develop' },
          ],
        },
      ],
    };
    let editor = startEditor(choiceForm);
    editor = editorKey(choiceForm, editor, press('down')).editor;
    editor = editorKey(choiceForm, editor, press('letter', 'd')).editor;
    expect(editor.choiceCustom).toBe(true);
    expect(editor.choiceFocus).toBe('custom');
    // Ctrl+E is the explicit keyboard path back to the option list.
    editor = editorKey(choiceForm, editor, { ...press('e'), ctrl: true }).editor;
    expect(editor.choiceCustom).toBe(false);
    expect(editor.choiceFocus).toBe('list');
    editor = editorKey(choiceForm, editor, press('return')).editor;
    expect(editor.answers['branch']).toBe('develop');
  });

  test('caret movement while the option list owns focus cannot commit stale custom text (#269)', () => {
    const choiceForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'develop', label: 'develop' },
          ],
        },
      ],
    };
    let editor = startEditor(choiceForm);
    for (const character of 'feature/old') {
      editor = editorKey(choiceForm, editor, press('letter', character)).editor;
    }
    // Browse back to the listed option: the list and the listed value own the keyboard.
    editor = editorKey(choiceForm, editor, press('down')).editor;
    expect(editor.choiceCustom).toBe(false);
    for (const name of ['left', 'right', 'home', 'end']) {
      editor = editorKey(choiceForm, editor, press(name)).editor;
      expect(editor.choiceCustom).toBe(false);
      expect(editor.choiceFocus).toBe('list');
      expect(editor.text).toBe('feature/old');
    }
    editor = editorKey(choiceForm, editor, press('end')).editor;
    editor = editorKey(choiceForm, editor, press('return')).editor;
    expect(editor.answers['branch']).toBe('develop');
  });

  test('custom focus makes Home/End caret actions without choosing a listed option (#269)', () => {
    const choiceForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'develop', label: 'develop' },
          ],
        },
      ],
    };
    let editor = startEditor(choiceForm);
    for (const character of 'feature/abcd') {
      editor = editorKey(choiceForm, editor, press('letter', character)).editor;
    }
    editor = editorKey(choiceForm, editor, press('home')).editor;
    expect(editor.textCursor).toBe(0);
    expect(editor.choiceCustom).toBe(true);
    expect(editor.choiceFocus).toBe('custom');
    editor = editorKey(choiceForm, editor, press('right')).editor;
    expect(editor.textCursor).toBe(1);
    editor = editorKey(choiceForm, editor, press('end')).editor;
    expect(editor.textCursor).toBe('feature/abcd'.length);
    editor = editorKey(choiceForm, editor, press('return')).editor;
    expect(editor.answers['branch']).toBe('feature/abcd');
  });

  test('Shift+Tab restores custom-choice focus and its caret (#269)', () => {
    const twoFields: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'branch',
          title: 'Branch',
          kind: 'choice',
          custom: true,
          options: [
            { value: 'main', label: 'main' },
            { value: 'develop', label: 'develop' },
          ],
        },
        { ...base, key: 'note', title: 'Note', kind: 'text', required: false },
      ],
    };
    let editor = startEditor(twoFields);
    for (const character of 'feature/xyz') {
      editor = editorKey(twoFields, editor, press('letter', character)).editor;
    }
    editor = editorKey(twoFields, editor, press('home')).editor;
    editor = editorKey(twoFields, editor, press('right')).editor;
    editor = editorKey(twoFields, editor, press('tab')).editor;
    expect(editor.index).toBe(1);
    editor = editorKey(twoFields, editor, { ...press('tab'), shift: true }).editor;
    expect(editor.index).toBe(0);
    expect(editor.text).toBe('feature/xyz');
    expect(editor.textCursor).toBe(1);
    expect(editor.choiceFocus).toBe('custom');
    expect(editor.choiceCustom).toBe(true);
  });

  test('paste inserts at the active cursor and Shift+Tab restores the caret (#232)', () => {
    const twoFields: FormRequest = {
      ...form,
      fields: [
        { ...base, key: 'one', title: 'One', kind: 'text', required: false },
        { ...base, key: 'two', title: 'Two', kind: 'text', required: false },
      ],
    };
    let editor = startEditor(twoFields);
    for (const character of 'hello') {
      editor = editorKey(twoFields, editor, press('letter', character)).editor;
    }
    editor = editorKey(twoFields, editor, press('left')).editor;
    editor = editorKey(twoFields, editor, press('left')).editor;
    const pasted = pasteFormText(twoFields, editor, 'XY');
    expect(pasted.editor.text).toBe('helXYlo');
    expect(pasted.editor.textCursor).toBe(5);

    editor = pasted.editor;
    editor = editorKey(twoFields, editor, press('tab')).editor;
    expect(editor.index).toBe(1);
    editor = editorKey(twoFields, editor, press('tab', undefined)).editor;
    // Shift+Tab back to the first field restores its caret.
    editor = editorKey(twoFields, editor, { ...press('tab'), shift: true }).editor;
    expect(editor.index).toBe(0);
    expect(editor.text).toBe('helXYlo');
    expect(editor.textCursor).toBe(5);
  });

  test('a custom multiselect draft edits at its own cursor (#232)', () => {
    const multiForm: FormRequest = {
      ...form,
      fields: [
        {
          ...base,
          key: 'tags',
          title: 'Tags',
          kind: 'multi',
          custom: true,
          options: [{ value: 'a', label: 'a' }],
        },
      ],
    };
    let editor = startEditor(multiForm);
    editor = editorKey(multiForm, editor, press('letter', 'a')).editor;
    expect(editor.addingCustom).toBe(true);
    for (const character of 'abcd') {
      editor = editorKey(multiForm, editor, press('letter', character)).editor;
    }
    editor = editorKey(multiForm, editor, press('left')).editor;
    editor = editorKey(multiForm, editor, press('letter', 'X')).editor;
    expect(editor.customDraft).toBe('abcXd');
    expect(editor.customCursor).toBe(4);
    editor = editorKey(multiForm, editor, press('backspace')).editor;
    expect(editor.customDraft).toBe('abcd');
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
