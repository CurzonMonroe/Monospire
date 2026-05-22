cask "monospire" do
  version "1.2.2"
  sha256 "1507e65044d3d7bc63f8d614a665348138a6590d61a16cf0ea031e8631027c32"

  url "https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.2/Monospire-1.2.2-arm64.dmg"
  name "Monospire"
  desc "Native-feeling macOS Markdown editor with dual editing views"
  homepage "https://github.com/CurzonMonroe/Monospire"

  auto_updates true
  depends_on macos: ">= :ventura"

  app "Monospire.app"

  zap trash: [
    "~/Library/Application Support/Monospire",
    "~/Library/Preferences/com.monospire.app.plist",
    "~/Library/Saved Application State/com.monospire.app.savedState",
  ]
end
