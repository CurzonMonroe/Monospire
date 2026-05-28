# Monospire

Monospire is a focused Markdown editor built with Electron. It provides raw and formatted editing views, bundled preview themes, syntax-highlighted code blocks, Mermaid rendering, document export, and native-feeling menus.

## Installation

### macOS with Homebrew

Install from the Monospire tap:

```bash
brew tap CurzonMonroe/monospire
brew install --cask monospire
```

The cask installs `Monospire.app` and links the app executable as `monospire`, so the app can also be launched from the shell:

```bash
monospire
monospire path/to/document.md
```

### macOS DMG

Download the DMG from the GitHub release page, open it, and drag `Monospire.app` into `Applications`.

Current ARM64 release:

```text
https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/Monospire-1.2.4-arm64.dmg
```

### Linux

Linux packages are published on the GitHub release page:

```text
https://github.com/CurzonMonroe/Monospire/releases/tag/v1.2.4
```

Linux packages are published for x64 and ARM64. Use the package that matches your machine:

```bash
uname -m
```

Use `x64`/`amd64`/`x86_64` packages on normal Intel or AMD Linux machines. Use `arm64`/`aarch64` packages on ARM64 Linux machines.

Debian and Ubuntu:

```bash
# Intel/AMD x64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire_1.2.4_amd64.deb
sudo apt install ./monospire_1.2.4_amd64.deb

# ARM64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire_1.2.4_arm64.deb
sudo apt install ./monospire_1.2.4_arm64.deb
```

Fedora:

```bash
# Intel/AMD x64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.x86_64.rpm
sudo dnf install ./monospire-1.2.4.x86_64.rpm

# ARM64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.aarch64.rpm
sudo dnf install ./monospire-1.2.4.aarch64.rpm
```

RHEL, CentOS, Rocky Linux, and AlmaLinux:

```bash
# Intel/AMD x64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.x86_64.rpm
sudo dnf install ./monospire-1.2.4.x86_64.rpm

# ARM64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.aarch64.rpm
sudo dnf install ./monospire-1.2.4.aarch64.rpm
```

openSUSE:

```bash
# Intel/AMD x64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.x86_64.rpm
sudo zypper install ./monospire-1.2.4.x86_64.rpm

# ARM64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.aarch64.rpm
sudo zypper install ./monospire-1.2.4.aarch64.rpm
```

AppImage, for distributions where a package install is not preferred:

```bash
# Intel/AMD x64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/Monospire-1.2.4.AppImage
chmod +x Monospire-1.2.4.AppImage
./Monospire-1.2.4.AppImage

# ARM64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/Monospire-1.2.4-arm64.AppImage
chmod +x Monospire-1.2.4-arm64.AppImage
./Monospire-1.2.4-arm64.AppImage
```

Portable tarball:

```bash
# Intel/AMD x64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4.tar.xz
tar -xf monospire-1.2.4.tar.xz
./monospire

# ARM64
wget https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/monospire-1.2.4-arm64.tar.xz
tar -xf monospire-1.2.4-arm64.tar.xz
./monospire
```

Installing directly with `apt install monospire` requires a published APT repository. The `.deb` release asset is installable with `apt`, but it does not make Monospire available by package name until an APT repository is added.

## Mindmap View

Monospire includes a readonly Mindmap view for Markdown lists. The Markdown document remains the source of truth; Mindmap view renders headings and nested lists as a diagram with branch colours, task states, optional icons, optional local image thumbnails, zoom/fit controls, source-line selection, diagnostics, and SVG/PDF export.

Example:

```markdown
# Product Strategy

- Monospire <!-- mindmap: color=blue icon=idea -->
  - Markdown editor
    - Raw mode
    - Preview mode
  - Mindmap mode <!-- mindmap: color=green shape=pill -->
    - [x] Readonly v2
    - [ ] Editable v3 foundation
  - Launch assets <!-- mindmap: image=assets/monospire-icon-1024.png fill=#eef2ff -->
```

Supported optional metadata uses Markdown comments immediately after or inside a list item:

```markdown
- Node label <!-- mindmap: color=purple fill=#f5f3ff icon=star shape=rounded image=assets/example.png -->
```

Mindmap export is available from the File menu and the Mindmap toolbar.

Monospire can also open MindManager `.mmap` files as an import. The original `.mmap` file is left untouched; Monospire converts the topic tree into a new unsaved Markdown document so it can be reviewed, edited, and saved as normal Markdown.

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

Build the macOS release and upload the DMG assets to the matching GitHub release:

```bash
npm run release:mac
```

`release:mac` expects `GITHUB_RELEASE_TOKEN` or `GH_RELEASE_TOKEN` to be available with GitHub Contents read/write access. It uses ad-hoc signing by default to avoid local keychain ambiguity during packaging.

Expected outputs include:

- `dist/mac-arm64/Monospire.app`
- `dist/Monospire-<version>-arm64.dmg`
- `dist/Monospire-<version>-arm64.dmg.blockmap`
- `dist/latest-mac.yml`
- `homebrew/Casks/monospire.rb`
- `homebrew/Casks/Monospire.dmg/Monospire-<version>-arm64.dmg`

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

The cask installs `Monospire.app` and links the app executable as `monospire`, so the app can be launched from the shell after installation:

```bash
monospire
monospire path/to/document.md
```

The generated Homebrew release payload is copied to:

```text
homebrew/Casks/Monospire.dmg/
```

## Release Checklist

1. Update `package.json` version and `build.buildVersion`.
2. Run `npm run release:mac`.
3. Confirm `homebrew/Casks/monospire.rb` has the expected version, URL, and SHA256.
4. Confirm the matching GitHub release has `Monospire-<version>-arm64.dmg` and `.dmg.blockmap`.
5. Confirm the Gitea Linux build has uploaded the `.AppImage`, `.deb`, `.rpm`, and `.tar.xz` assets to the matching GitHub release tag.
6. Commit the source changes and updated Homebrew cask files.
