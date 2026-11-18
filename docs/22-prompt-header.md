### Context-aware sticky prompt header

The terminal chat should have a **sticky user-prompt header** that changes dynamically based on scroll position.

- **At the bottom of the conversation:** The latest user prompt remains pinned to the topmost line of the terminal viewport, while the agent's response scrolls underneath it.
- **Scrolling backward:** As the user scrolls into earlier parts of the conversation, the sticky header switches to the user prompt associated with the section currently being viewed.
- **Reaching the original prompt:** When that prompt's actual message becomes visible in the scrollback, the sticky copy disappears. The original message scrolls normally with the conversation.
- **Scrolling forward again:** Once the original prompt scrolls above the viewport, it becomes sticky again, until the next user prompt takes over.

**Implementation model:** Treat user prompts as sticky section headers in a reverse-scrolling conversation. The header represents the most recent user prompt preceding the currently visible content, not necessarily the latest prompt in the session.

The sticky header should never duplicate a prompt already visible in the viewport, should not cause content to jump when switching prompts, and should consume minimal vertical space. Long prompts should be truncated or summarized to fit the available width, without modifying the actual message in scrollback.
