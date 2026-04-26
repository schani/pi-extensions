# pi-agent-mood

A pi extension package that shows the coding agent's current **activity / mood** in the footer.

The mood is produced by a secondary cheap model that reads a compact snapshot of the latest conversation. The extension does not use local mood heuristics: when it is time to update, it asks the mood model to choose a one-word activity, one-word mood, and emoji for each.

Example footer status:

```text
🛠️ building / 🎯 focused
```

## Features

- Shows the agent's latest apparent activity and mood in pi's footer
- Uses a configurable cheap model priority list
- Focuses the classifier on the **current/latest** agent state, not the average mood of the whole transcript
- Sends only the latest 10 KB of compact conversation snapshot to the mood model
- Uses compact tool metadata instead of full tool arguments or outputs
- Includes diagnostics for model resolution and auth issues
- Optional detailed widget above the editor

## Model priority

Default priority:

1. `google/gemini-3.1-flash-lite-preview`
2. `anthropic/claude-haiku-4.5`
3. `openai/gpt-5.4-nano`

These names may resolve to gateway models, for example OpenRouter models whose model IDs include provider prefixes. The resolver first tries exact model-id matches, then falls back to `provider/model` matching.

Override the first-choice model:

```bash
pi --agent-mood-model openrouter/google/gemini-3.1-flash-lite-preview
```

Override the full priority list:

```bash
pi --agent-mood-models google/gemini-3.1-flash-lite-preview,anthropic/claude-haiku-4.5,openai/gpt-5.4-nano
```

## Update cadence

The extension recomputes mood from message growth:

- After each user message, while the current turn is under 5 KB: every 512 B
- Once the current turn reaches 5 KB: every 2 KB
- Every assistant tool call counts as 256 B for recompute scheduling
- Each model call receives the latest 10 KB of rendered snapshot

The threshold window resets at the latest user message, so long sessions still get fast 512 B mood updates at the start of every new user turn. In other words, scheduling is based on bytes accumulated since the latest user message, not total session size. The current-turn byte count includes the latest user message, assistant text, and assistant tool-call metadata. It does not immediately recompute just because a new user message arrived; it recomputes once enough current-turn bytes have accumulated, or immediately when forced with `/mood-refresh`.

Tool result output does not count toward the recompute threshold, and full tool output is never sent to the mood model.

## Snapshot contents

The classifier sees user/assistant text and compact tool metadata:

- `read`: file path and available read byte counts
- `write`: file path and content byte count
- `edit`: file path, edit count, and new text byte count
- `bash`: command truncated to 256 bytes, plus full command byte length
- `grep` / `search`: pattern/query, path/glob scope, and result counts
- tool results: success/error and available read/output/diff byte counts

Obvious secrets and email addresses are redacted before the snapshot is sent to the mood model.

## Commands

- `/mood` - show the current classified mood
- `/mood-refresh` - force a classifier update
- `/mood-model` - show model resolution diagnostics
- `/mood-models` - alias for `/mood-model`

## Optional widget

Enable a detailed widget above the editor:

```bash
pi --agent-mood-widget
```

The widget shows the activity/mood, short reason, confidence, and selected classifier model.

## Install

```bash
pi install npm:pi-agent-mood
```

For local development from this repository:

```bash
pi -e ./extensions/agent-mood.ts
```

Or install this package locally into the current project:

```bash
pi install -l ./
```

Then use `/reload` in pi after changes.

## Development

```bash
npm run check
npm test
```

The tests cover model matching, recompute thresholds, UTF-8 truncation, redaction, and tool metadata rendering.

## Notes

- This is a UI indicator only. The extension does not claim the model has real feelings.
- Mood state is persisted as extension custom entries and is not injected into the main agent context.
- The secondary mood model has no tools; it only classifies the recent snapshot.
