# Monospire Handover

Last updated: 2026-05-28

## Current State

- Current app version is `2.0.2`.
- `main` has been pushed to both configured remotes.
- Tag `v2.0.2` has been pushed.
- GitHub release `v2.0.2` has macOS artifacts uploaded and verified.
- Homebrew tap `CurzonMonroe/homebrew-monospire` has been updated to cask version `2.0.2`.
- `brew fetch --cask --force curzonmonroe/monospire/monospire` verified `Cask monospire (2.0.2)`.

## Working Tree At Handover

There is one small uncommitted UI polish change:

- `index.html`
- `styles.css`

This makes the Outline viewer title use the same uppercase pane header styling as Markdown, Preview, and Mindmap, with a matching light/dark background hue. The change has already passed:

```bash
npm test
node --check renderer.js
node --check renderer-pane-layout.js
node --check renderer-mindmap-view.js
node --check main.js
node --check preload.js
node --check mindmap-core.js
node --check mmap-importer.js
git diff --check
```

## Important Project Shape

Monospire is an Electron Markdown editor. The app is still mostly renderer-centric, but recent refactoring extracted some high-value seams:

- `mindmap-core.js`: pure mindmap parsing, metadata, layout, and export-friendly data.
- `mmap-importer.js`: MindManager `.mmap` import support.
- `renderer-pane-layout.js`: pane visibility, splitter, and width logic.
- `renderer-mindmap-view.js`: readonly SVG mindmap rendering and viewport behaviour.
- `renderer.js`: still owns much of the UI orchestration, document state, command handling, editor behaviour, outline rendering, import/export flows, and IPC usage.

The extraction direction that has worked well is: move testable, stateful-but-contained behaviour out of `renderer.js` behind small controller APIs, then add focused Node tests.

## Mindmap Features Already Implemented

- Markdown list based mindmap source of truth.
- Readonly Mindmap pane.
- Node colours and metadata comments such as:

```markdown
- Example <!-- mindmap: color=blue icon=idea shape=pill fill=#eef2ff -->
```

- Multiple layout modes from View > MindMap Layout:
  - Balanced
  - Right
  - Left
  - Vertical
  - Radial
- Layout changes trigger redraw.
- Zoom, fit, reset, pan/scroll behaviour.
- Mindmap export supports SVG and PDF.
- Dark mode uses a dark Mindmap canvas while keeping node boxes readable.
- `.mmap` files can be opened/imported, including launch arguments from Finder/file association.
- Clicking mindmap nodes can locate source where applicable.

## UI Notes

Recent UI regressions were fixed around:

- Main editor/preview/mindmap pane styling.
- Tools menu.
- Settings dialog layout.
- About dialog and transparent app icon.
- Mindmap canvas filling its pane.
- Mindmap title background hue.
- Pane splitters and reduced splitter spacing.
- Centered text in mindmap nodes.
- Adjustable editor/preview/mindmap pane widths.
- Outline title styling is now implemented but not yet committed.

The user is sensitive to preserving the `1.2.6` visual feel while adding v2 functionality. When changing UI, compare against existing pane/title/ribbon patterns before inventing new styling.

## Release Flow

For a macOS/Homebrew release:

1. Update `package.json` `version`.
2. Update `package.json` `build.buildVersion`.
3. Run tests and syntax checks.
4. Build:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

5. Verify generated cask and DMG hash:

```bash
sed -n '1,18p' homebrew/Casks/monospire.rb
shasum -a 256 dist/Monospire-<version>-arm64.dmg homebrew/Casks/Monospire.dmg/Monospire-<version>-arm64.dmg
```

6. Commit version/cask changes and tag:

```bash
git add package.json package-lock.json homebrew/Casks/monospire.rb
git commit -m "Release Monospire <version>"
git tag -a v<version> -m "Monospire <version>"
git push origin main
git push origin v<version>
```

7. Upload only the intended version artifacts. Avoid broad patterns if older DMGs remain in `dist`:

```bash
GITHUB_RELEASE_ARTIFACT_PATTERNS='Monospire-<version>-arm64.dmg Monospire-<version>-arm64.dmg.blockmap latest-mac.yml' \
  bash scripts/upload-macos-artifacts-to-github-release.sh
```

8. Verify public release URLs with `curl -L -I`.
9. Clone/update the Homebrew tap, copy `homebrew/Casks/monospire.rb`, commit, push.
10. Verify:

```bash
brew update
brew fetch --cask --force curzonmonroe/monospire/monospire
```

## Local Dev

Start the app from this working tree:

```bash
npm start
```

Or, to force a fresh Electron window:

```bash
pkill -f "/Users/darrenwray/Documents/New project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/darrenwray/Documents/New project" || true
open -n "/Users/darrenwray/Documents/New project/node_modules/electron/dist/Electron.app" --args "/Users/darrenwray/Documents/New project"
```

To test opening a `.mmap` file through app arguments:

```bash
open -n "/Users/darrenwray/Documents/New project/node_modules/electron/dist/Electron.app" --args "/Users/darrenwray/Documents/New project" "/path/to/file.mmap"
```

## Tests

Primary check:

```bash
npm test
```

Current test script runs:

- `tests/mindmap-core.test.js`
- `tests/mmap-importer.test.js`
- `tests/renderer-pane-layout.test.js`
- `tests/renderer-mindmap-view.test.js`

Useful syntax pass:

```bash
node --check renderer.js
node --check renderer-pane-layout.js
node --check renderer-mindmap-view.js
node --check main.js
node --check preload.js
node --check mindmap-core.js
node --check mmap-importer.js
git diff --check
```

## Watch Outs

- Do not revert unrelated user changes. The user often tests visually between turns.
- `README.md` still references older `v1.2.4` release links in places and could use a release-documentation refresh.
- `todo.md` contains many unchecked v2 planning items even though much of v2 has shipped. Treat it as historical unless refreshed.
- `renderer.js` is still large. Good next refactor candidates:
  - outline controller
  - command palette/controller
  - settings dialog controller
  - document import/export controller
  - editor keyboard behaviour
- Release upload scripts may be quiet during large DMG uploads. Be patient and avoid inspecting command arguments in a way that could expose tokens.
- `asar` is disabled in the builder config. Electron Builder warns about this during packaging.

## Suggested Next Steps

1. Commit the Outline header styling polish if it looks good in the running app.
2. Refresh `README.md` release links to `2.0.2`.
3. Clean up `todo.md` so completed v2 work is marked accurately or move old requirements into an archive section.
4. Continue modularising `renderer.js`, starting with Outline because it is small and currently adjacent to the recent UI change.
