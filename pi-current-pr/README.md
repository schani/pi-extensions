# pi-current-pr

A pi extension package that shows the current GitHub pull request in a widget above the editor.

## Features

- Shows the current PR title and URL
- Uses `gh pr view` to detect the PR for the current branch
- Renders compactly in one line when it fits
- Falls back to two lines when space is tight

## Install

### Local

```bash
pi install /home/schani/Work/pi-extensions/pi-current-pr
```

### Development

You can also test it directly from the extension source:

```bash
pi -e /home/schani/Work/pi-extensions/pi-current-pr/extensions/current-pr-widget.ts
```

## Package layout

```text
pi-current-pr/
  package.json
  README.md
  extensions/
    current-pr-widget.ts
```

## Notes

- Requires `gh` to be installed and authenticated
- Intended for use inside git repositories with GitHub pull requests
