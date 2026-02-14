# Monospire

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
