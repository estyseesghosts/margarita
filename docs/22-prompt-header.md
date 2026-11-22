### Context-aware sticky prompt header

The terminal chat should have a **sticky user-prompt header** that changes dynamically based on scroll position.

- **Following the live tail:** No prompt is pinned. The header is contextual reading chrome, so it must not permanently occupy the top line while fresh output streams.
- **Scrolling backward:** Once the reader deliberately leaves the tail (outside a two-row bottom tolerance), the sticky header shows the user prompt associated with the section currently being viewed.
- **Reaching the original prompt:** When that prompt's actual message becomes visible in the scrollback, the sticky copy disappears. The original message scrolls normally with the conversation.
- **Returning to the tail:** `Ctrl+End` or a manual scroll back to the bottom clears the header immediately. Scrolling up again restores the preceding prompt on the next layout.

**Implementation model:** Treat user prompts as sticky section headers in a reverse-scrolling conversation. The header represents the most recent user prompt preceding the currently visible content, not necessarily the latest prompt in the session.

The scrollbox's own tail state decides visibility: following the live tail (within a small physical-row tolerance) hides the strip, while history reading derives identity from prompt position. Position and visibility are separate policies. The sticky header should never duplicate a prompt already visible in the viewport, should not cause content to jump when switching prompts, and should consume minimal vertical space. It is an overlay row, so it never takes a row from the composer, footer or pinned permission/question cards. Long prompts should be truncated or summarized to fit the available width, without modifying the actual message in scrollback.
