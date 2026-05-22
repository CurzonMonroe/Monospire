cask "monospire" do
  version "1.2.3"
  sha256 "b9bb06faeaa94d454dc91cd2614dfa15002d43a3c3e6a1fa6b3349323d1c13d7"

  url "https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.3/Monospire-1.2.3-arm64.dmg"
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
