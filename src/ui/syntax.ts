import { SyntaxStyle } from '@opentui/core';

import type { Theme } from './theme.ts';

type Owner = Parameters<typeof SyntaxStyle.fromStyles>[1];

/** Markdown and code colours derived from the semantic theme. */
export function createSyntaxStyle(theme: Theme, owner: Owner): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      default: { fg: theme.text },
      'markup.heading': { fg: theme.accent, bold: true },
      'markup.heading.1': { fg: theme.accent, bold: true, underline: true },
      'markup.strong': { fg: theme.text, bold: true },
      'markup.italic': { fg: theme.text, italic: true },
      'markup.strikethrough': { fg: theme.dim, strikethrough: true },
      'markup.raw': { fg: theme.accentLight },
      'markup.raw.block': { fg: theme.text },
      'markup.link': { fg: theme.dim, underline: true },
      'markup.link.url': { fg: theme.dim, underline: true },
      'markup.list': { fg: theme.accent },
      'markup.quote': { fg: theme.dim, italic: true },
      conceal: { fg: theme.dim },
      keyword: { fg: theme.accent, bold: true },
      'keyword.import': { fg: theme.accent },
      string: { fg: theme.success },
      comment: { fg: theme.dim, italic: true },
      number: { fg: theme.warn },
      boolean: { fg: theme.warn },
      constant: { fg: theme.warn },
      function: { fg: theme.accentLight },
      'function.method': { fg: theme.accentLight },
      type: { fg: theme.accentLight },
      variable: { fg: theme.text },
      property: { fg: theme.text },
      operator: { fg: theme.dim },
      punctuation: { fg: theme.dim },
      tag: { fg: theme.accent },
      attribute: { fg: theme.accentLight },
    },
    owner,
  );
}
