Claude Code uses three different rendering systems: one for Markdown responses, one for source-code diffs, and one for compact tool activity. They're related visually, but have different rules.

For your OpenCode v2 frontend, I would reproduce these as separate components rather than trying to build a single universal message renderer.

## 1. Markdown rendering

Claude Code uses terminal-native formatting rather than displaying Markdown as raw source or embedding a browser.

Third-party source analyses identify this rendering pipeline:

Streaming Markdown text

Markdown parser (`marked`)

Headings, paragraphs, lists, tables, code fences

Terminal formatting and syntax highlighting

ANSI styling, language-aware code coloring

Ink terminal components

The implementation analyses identify several techniques:

- `marked` parses Markdown into tokens.
- `cli-highlight` provides syntax coloring for fenced code blocks.
- Markdown parsing results are cached to reduce repeated work.
- Plain text can bypass the full Markdown parser.
- Code highlighting loads asynchronously so uncolored text can appear immediately.
- Tables receive specialized layout handling.

These are findings from third-party code analysis, not a published Anthropic architecture specification.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://claude-code-from-source.com\&sz=32)

Claude Code from Source+1



Claude Code does not perfectly support every GitHub Flavored Markdown feature. Its output also follows terminal-width and theme constraints. The official `/theme` menu allows code highlighting to be toggled.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



For your frontend: preserve the Markdown structure, but render it with minimal terminal styling. Bold text, clear heading hierarchy, compact lists, readable tables and highlighted code are useful. Avoid excessive boxes, borders, and vertical padding.

## 2. Syntax highlighting and line numbering in Edit calls

Claude Code treats edits as structured diffs, not Markdown code blocks.

The source analysis describes a `StructuredDiff` component backed by a native Rust `color-diff` module. Its job is to combine source syntax highlighting with changes between old and new file contents.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



src/components/renderer.ts

Edit

41

41



function renderMessage(msg: Message) {

42



−

&#x20; return renderPlainText(msg.content);



42

\+

&#x20; return renderMarkdown(msg.content);

43

43



}

Illustrative diff layout; the actual terminal styling varies by theme and renderer.

The important mechanics are:

- Line numbers: The diff stores separate old and new line positions. Numbers refer to the original file, not the beginning of the displayed snippet.
- Context: Unchanged lines surrounding an edit are included, typically three lines.
- Color: Added and removed lines receive different backgrounds and markers; syntax colors remain useful within the content.
- Width: The line-number gutter is sized dynamically, and long lines must be clipped or wrapped without corrupting ANSI color sequences.
- Caching: Rendered diffs are cached against inputs including theme, width and file path.

The native module has a simpler fallback when highlighting is unavailable.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



For your implementation, I'd use two independent passes: calculate a structured diff first, then syntax-highlight the old and new text, applying change decorations afterward. That keeps syntax colors from fighting the diff colors.

## 3. How Claude Code condenses tool calls

This is mostly a presentation decision made by the terminal frontend, not something the model decides.

Claude Code's default is to show a compact summary, grouping related calls together. Its `Ctrl+O` transcript viewer reveals the underlying calls and results. Anthropic documents this behavior, including grouped MCP calls such as `Called slack 3 times`.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://code.claude.com\&sz=32)

Claude Code Docs+1



Collapsed transcript

Read 4 files, searched for 3 patterns

Edited 2 files (+38 / −12)

Ran 3 shell commands

The source analysis identifies three important behaviors:

- Grouping by operation: Related file reads and searches can share one summary.
- Collapsed from the beginning: A group does not repeatedly expand and collapse as calls finish.
- Stable display: A short-lived operation's status hint can persist briefly (700 ms in the analyzed implementation), and summary counts do not regress during rendering.

This avoids the terminal jumping around whenever another tool completes.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://quidproquo.cc\&sz=32)

quidproquo.cc



The exact grouping rules for every tool type are not fully documented publicly, and they have changed across versions.

## 4. What I would implement in your frontend

I'd adopt Claude Code's approach with one improvement: keep enough information visible to distinguish what the agent actually did.

Transcript density

CompactDetailed

Explored renderer implementation

Read 4 files · Searched 3 patterns

Edited src/renderer.ts

+18 / −7 lines

The grouping rules I'd give your implementer are:

1. Group adjacent read-only exploration calls (`Read`, `Grep`, `Glob`, file listings) within the same uninterrupted activity segment.
2. Keep mutations identifiable. An edit, command, test, commit or failure should have a useful summary, even when several are grouped.
3. Never group across user prompts. Also preserve meaningful assistant commentary between operations.
4. Keep running operations visible. Update a compact row in place rather than adding and removing rows.
5. Never discard detail. Expanded transcript must retain inputs, outputs, diffs, errors, timestamps and available model reasoning.
6. Honor manual expansion. Don't automatically collapse something the user chose to inspect.

For implementation, keep the full event history immutable and derive compact groups from it. The grouping layer should never change the actual agent transcript or model context.

### Useful references

- [Claude Code settings — transcript modes and syntax highlighting](https://code.claude.com/docs/en/settings-reference?utm_source=chatgpt.com)
- [Claude Code terminal rendering architecture — third-party analysis](https://claude-code-from-source.com/ch13-terminal-ui/?utm_source=chatgpt.com)
- [Structured diff implementation analysis](https://github.com/Topaz1618/claude-code-docs/blob/main/en/docs/05-code-editing-strategy.md?utm_source=chatgpt.com)
- [pi-compact-tools — open-source example of Claude-style tool grouping](https://pi.dev/packages/pi-compact-tools?utm_source=chatgpt.com)

The last project is especially useful as an implementable reference. You can examine its grouping and rendering code without having to reverse-engineer Claude Code's proprietary implementation.
