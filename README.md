# Monospire

Monospire is a macOS Markdown editor built with Electron. It provides raw and formatted editing views, bundled preview themes, syntax-highlighted code blocks, Mermaid rendering, document export, and native-feeling macOS menus.

## Development

Install dependencies:

```bash
npm install
```

Run the development app:

```bash
npm start
```

This starts Electron from the project root with the local source files.

## Build Outputs

Build a distributable macOS release:

```bash
npm run dist:mac
```

This creates the macOS app and DMG under `dist/`, then updates the Homebrew release files.

Expected outputs include:

- `dist/mac-arm64/Monospire.app`
- `dist/Monospire-1.2.2-arm64.dmg`
- `dist/Monospire-1.2.2-arm64.dmg.blockmap`
- `dist/latest-mac.yml`
- `homebrew/Casks/monospire.rb`
- `homebrew/Casks/Monospire.dmg/Monospire-1.2.2-arm64.dmg`

If local Apple signing identities are ambiguous or unavailable, build with ad-hoc signing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

Ad-hoc builds are useful for local distribution/testing, but notarization is skipped.

## App-Only Packaging

Build just a `.app` bundle:

```bash
npm run pack:app
```

By default this creates a universal app. To choose an architecture:

```bash
MONOSPIRE_ARCH=universal npm run pack:app
MONOSPIRE_ARCH=arm64 npm run pack:app
MONOSPIRE_ARCH=x64 npm run pack:app
```

The app bundle is written under `dist/`, for example `dist/mac-universal/Monospire.app`.

## Homebrew Cask

The cask lives at:

```text
homebrew/Casks/monospire.rb
```

Generate or refresh the cask from the current `dist` DMG:

```bash
npm run brew:cask
```

The generator defaults to:

- Version from `package.json`
- DMG at `dist/Monospire-<version>-arm64.dmg`
- URL `https://github.com/CurzonMonroe/Monospire/releases/download/v<version>/Monospire-<version>-arm64.dmg`
- Homepage `https://github.com/CurzonMonroe/Monospire`

The generated Homebrew release payload is copied to:

```text
homebrew/Casks/Monospire.dmg/
```

## Release Checklist

1. Update `package.json` version and `build.buildVersion`.
2. Run `npm run dist:mac`.
3. Confirm `homebrew/Casks/monospire.rb` has the expected version, URL, and SHA256.
4. Publish `dist/Monospire-<version>-arm64.dmg` to the matching GitHub release tag.
5. Commit the source changes and updated Homebrew cask files.
