# Monospire

Monospire is a native-feeling macOS desktop Markdown editor built with Electron.

## Features

- `Raw Markdown`, `Formatted Markdown`, and `Side by side` views
- Edit from either pane with bidirectional sync
- Low-flash rendering updates using DOM patching (`morphdom`)
- Native-style menus (`File`, `Edit`, `View`, `Tools`) and in-window ribbon
- Edit menu includes standard edit operations and a Markdown Format section
- Ribbon is dedicated to Markdown formatting actions
- File operations: `New`, `Load`, `Save`, `Save As`, `Exit`
- Unsaved-change confirmation on close, load, and new document
- Per-view zoom controls (raw and formatted)
- Theme CSS loading (`.css`) for standard Markdown HTML styling
- Ribbon display options: `Icons only`, `Text only`, `Icons and Text`
- Light/dark mode switching
- About dialog with version details
- Draggable custom title bar with file name state

## Run

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start app:
   ```bash
   npm start
   ```

## Package .app (macOS)

Build a macOS `.app` bundle:

```bash
npm run pack:app
```

By default this creates a universal app. You can target a specific architecture:

```bash
MONOSPIRE_ARCH=universal npm run pack:app
MONOSPIRE_ARCH=arm64 npm run pack:app
MONOSPIRE_ARCH=x64 npm run pack:app
```

The built app is written under `dist/` (for example `dist/mac-universal/Monospire.app`).

## Homebrew Cask Files

This repo includes a Homebrew cask scaffold at:

- `homebrew/Casks/monospire.rb`

To generate a release-ready cask with the correct SHA256 from a built DMG:

```bash
bash ./scripts/generate-homebrew-cask.sh \
  --dmg /absolute/path/to/Monospire.dmg \
  --url https://github.com/<owner>/<repo>/releases/download/v1.2.1/Monospire-1.2.1.dmg \
  --homepage https://github.com/<owner>/<repo>
```

This writes `homebrew/Casks/monospire.rb` with the computed hash and provided URL.
