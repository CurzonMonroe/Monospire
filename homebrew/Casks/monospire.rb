cask "monospire" do
  version "1.2.4"
  sha256 "0dda9f5ba702d3340a7cddb3bdff4785a378a8061fb5a62211aa0d40f935f77f"

  url "https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.4/Monospire-1.2.4-arm64.dmg"
  name "Monospire"
  desc "Native-feeling macOS Markdown editor with dual editing views"
  homepage "https://github.com/CurzonMonroe/Monospire"

  depends_on macos: ">= :ventura"

  app "Monospire.app"
  binary "#{appdir}/Monospire.app/Contents/Resources/app/scripts/monospire-cli", target: "monospire"

  zap trash: [
    "~/Library/Application Support/Monospire",
    "~/Library/Preferences/com.monospire.app.plist",
    "~/Library/Saved Application State/com.monospire.app.savedState",
  ]
end
