# pi-companion

A pi extension package that shows a cursor-following floating status pill for live agent activity. It is based on the Glimpse companion example and adds support for showing the agent's current **activity / mood** from [`pi-agent-mood`](https://github.com/schani/pi-extensions/tree/main/pi-agent-mood).

## Features

- Shows a translucent Glimpse pill near the cursor while pi is working
- Displays current status such as thinking, reading, editing, running, searching, done, or error
- Shows the current file, command, or search target when available
- Shows elapsed time and context usage percentage
- Shows model-classified mood when `pi-agent-mood` has produced one, for example:

```text
🛠️ building / 🎯 focused · 14% · 22s
```

- Supports multiple concurrent pi sessions through a shared local socket
- Auto-spawns the companion process and auto-exits when idle
- Persists `/companion` enabled/disabled state in `~/.pi/agent/companion.json`

## Install

```bash
pi install npm:pi-companion
```

For local development from this repository:

```bash
npm install
pi -e ./extensions/index.ts
```

Or install this package locally into the current project:

```bash
pi install -l ./
```

Then use `/reload` in pi after changes.

## Usage

Use the command inside pi:

```text
/companion
```

The command toggles the overlay on or off. When enabled, pi shows a small `G ·` status marker in the footer.

## Mood integration

This companion is decoupled from mood classification. To see mood in the floating pill, also install or load `pi-agent-mood`:

```bash
pi install npm:pi-agent-mood
```

`pi-agent-mood` persists its latest state as a custom session entry. The companion reads that state and includes it in the Glimpse overlay whenever available. If `pi-agent-mood` is not loaded or has not classified a mood yet, the companion simply omits the mood segment.

## Development

```bash
npm run check
```

## Notes

- Requires `glimpseui`; it is listed as a runtime dependency and is installed automatically when pi installs this package from npm or git.
- Follow-cursor support depends on platform capabilities reported by Glimpse.
- The mood display is a UI label only; it does not imply that the model has real feelings.
