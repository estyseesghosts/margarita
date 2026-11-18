# 12 — Permissions, forms, safety and external commands

## Design decision: permissions are not `Shift+Tab`

Unlike Claude Code, our `Shift+Tab` cycles **OpenCode agents**. A `plan` agent can have read-only permissions by server configuration, but the key is **agent selection**. We will not implement fake "Default / Plan / Auto-accept" banners that suggest a policy switch the server never applied. The OpenCode API includes `Session.Info.permissions`, permission requests and reply endpoints, and agents can have specific rules. [OpenCode agents](https://opencode.ai/docs/agents/), [OpenCode API](https://opencode.ai/docs/api).

## Permission state machine

```text
not requested → permission.asked → pending local UI
pending → user chooses once / always / reject
       → submitting → server confirmed permission.replied
       → running OR more permissions OR failure
```

Refresh pending permissions when attaching or reconnecting. A permission may be answered in a different client: if reply returns not found/conflict, fetch again and close only after confirming it is resolved. A permission prompt is allowed to interrupt visual flow because it's an actionable blocker; it should not take over entire transcript unnecessarily.

## Modal appearance and controls

Show one compact descriptive card anchored near composer:

```text
Allow bash command?
  cd C:\repo\kohjoh && git status
  [ Allow once ]  [ Always allow matching ]  [ Reject ]
```

Display resolved tool/command details, cwd and target files when supplied. Move focus with Tab/Left/Right; confirm with Enter; Escape should choose **reject** only if that is the documented safe behavior, otherwise close only after explaining the request remains pending. Avoid accidental default `Always` by placing `Allow once` first. For broad or destructive permissions include the exact scope and risk. `Always` is only shown if server supports durable/appropriate matching; don't implement unrestricted allow via frontend memory.

## Server API and reply contract

OpenCode v2 `GET /api/session/{id}/permission` returns pending requests; the reply operation `session.permission.reply` applies server-side decisions. OpenCode `Permission.Reply` includes `"once" | "always" | "reject"` [API schema](https://opencode.ai/docs/api). Confirm generated client request body shape on v2.3.0 before implementing. Form/question handling is independent: use `/session/{id}/form` listing and appropriate form reply endpoints; a form isn't a permission and must not accept `always`.

## Background session approvals

Overview must detect pending permission/form even when a session is detached. Highlight `Needs input` in the row and optionally show one muted notification (no focus steal). Selecting session should land at pending prompt. If more than one request is pending, queue modals oldest first and refresh after each response. Do not silently auto-reject due to navigation.

## Explicit shell mode

`!command` runs **user-directed shell command**, not the agent asking to run it. Claude Code's shell mode behaves this way [docs](https://code.claude.com/docs/en/interactive-mode). OpenCode's `session.shell` route executes a command in the session working directory and emits shell events [API](https://opencode.ai/docs/api). Investigate actual API guarantees before claiming it automatically feeds output back to model. UI should label user shell operations, show command/cwd, and avoid auto-granting agent permission based on user shell history.

Shell mode safety: treat cwd as explicit, keep shell history private to project, reject control characters/terminal escape injection in output, show exit code; dangerous commands should not be sent without deliberate Enter and visible text. If app cannot safely implement user shell within server API, disable feature with explanation instead of executing commands in an unrelated cwd.

## Model/remote security

- Default local service; remote `--server` is explicit and authenticated.
- Never print tokens, auth headers or secrets in debug traces, exported logs or screenshots.
- Don't let tool output inject ANSI escape sequences that manipulate screen or clipboard; sanitize output.
- Use OS app-data for frontend preferences; restrictive file permissions for sensitive drafts and plans.
- No automated telemetry in initial implementation.
- Server plugin tools remain server-governed. The frontend does not implement its own command runner for agent tools.
- If user asks to skip all permissions via CLI, don't invent a bypass; support only if the server exposes a verified permission policy configuration and show its scope.

## Future custom agents

A custom read-only research agent must enforce no-write rules at OpenCode's **server** permission layer and test that unsafe writes and shell commands fail. A UI badge reading `research` isn't a control. The agent picker should present permission summaries as descriptions, not as guarantees stronger than actual policy.

## Tests

1. Permission requested during A execution; Left goes overview; A remains blocked; switch back, approve once; run continues.
2. Simultaneous clients answer one permission; second gets resolved/conflict, not fake success.
3. `Always` scope narrower than full filesystem; UI shows actual target.
4. Form with multiple choices is not mistaken for permission.
5. Terminal escape injection in tool output is visibly escaped.
6. Reconnect while pending; request is restored and answerable.
7. Ctrl+C aborts execution through server, not an arbitrary pending permission.
