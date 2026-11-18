## Inline agent activity indicator

Implement a small, animated activity indicator inspired by Claude Code's spinner. It should communicate that the agent is working without introducing a progress bar, permanent header, or visually noisy loading component.

### Appearance and placement

The indicator lives **inline in the conversation**, attached to the current assistant turn, immediately after its latest output. It is not part of the application footer or a fixed status bar.

Example while working:

`◜ Wrangling… (13m 3s · ↓ 63.6k tokens)`

Example after completion:

`◌ Finished at 1:29 AM · 63.6k tokens`

The layout consists of a small animated Unicode glyph, a short activity verb, and muted metadata in parentheses. Keep everything on one line wherever terminal width permits.

### Text animation

The activity verb should have a **soft, continuous colour shimmer**. A slightly brighter colour travels horizontally across the individual letters, making the word appear to gently glow.

- Animate the colour of individual characters, not the position of the text.
- Use a moving highlight between two theme-aware colours, preferably the frontend's accent colour and a lighter variant.
- Keep the movement smooth and subtle, completing a pass approximately every 1.5–2 seconds.
- The text must remain fully legible throughout.
- The timer, token count, parentheses, and separators remain stationary and dimmed.

This should feel like a soft wave of colour passing through the word, not blinking text or a conventional loading bar.

### Our own Unicode animation

Instead of Claude's animated star, use a tiny **orbiting crescent**.

Frames:

`◜  ◝  ◞  ◟`

Cycle through these four Unicode characters in order, approximately every 150 ms. They resemble a little curved object orbiting clockwise inside a single terminal cell.

The glyph should use the same accent colours as the activity text, with a small brightness variation synchronized with the shimmer. No scaling, font-size changes, or layout movement.

Make sure each frame occupies exactly one terminal cell. Provide an ASCII fallback for terminals that cannot render the characters correctly.

### Activity text

Use short, slightly playful present-participle verbs such as:

`Thinking…` · `Tinkering…` · `Pondering…` · `Untangling…` · `Building…` · `Investigating…`

Rotate them occasionally during long tasks, but don't change them so frequently that the text becomes distracting. Prefer meaningful activity labels derived from agent state when available. A random verb is acceptable as decorative text, but must not imply an operation that isn't happening.

### Timing and metadata

- **Running:** Show elapsed wall-clock time since the current agent turn began, updating once per second.
- **Completed:** Stop the animation and replace the running duration with the actual completion time, formatted in the user's locale.
- **Token count:** Display actual reported usage, updating as new usage data arrives. Don't estimate unsupported values or confuse context-window occupancy with token consumption.
- **Interrupted or failed:** Freeze the indicator and show an appropriate short status such as `Interrupted` or `Failed`.
- **Restored sessions:** Preserve completed timestamps and usage in the transcript rather than restarting animations.

Use compact formatting such as `42s`, `3m 12s`, `1h 4m`, and `63.6k tokens`.

### Optional secondary line

Like Claude Code, we can occasionally show a small contextual tip beneath the activity indicator.

`└ Tip: Press Shift+Tab to switch agents`

Render tips in dimmed text, indented beneath the main line. They should be optional, infrequent, and relevant to our actual frontend controls.

### Implementation constraints

- The indicator belongs to the conversation renderer, not the OpenCode agent backend.
- Drive lifecycle, timing, and token metrics from actual OpenCode session/message events.
- Keep animation state independent of agent execution and message storage.
- Only animate currently active turns. Historical messages remain static.
- Respect reduced-motion preferences and offer a no-animation setting.
- Avoid unnecessary terminal redraws. The spinner and shimmer should update without disturbing surrounding transcript content.
- Gracefully shorten or omit metadata on narrow terminals.

**Design goal:** A quiet, slightly playful sign of life that makes long-running tasks feel active, while remaining as visually minimal as the rest of the interface.
