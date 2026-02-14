cask "monospire" do
  version "1.2.1"
  sha256 :no_check

  url "https://github.com/your-org/monospire/releases/download/v#{version}/Monospire-#{version}.dmg"
  name "Monospire"
  desc "Native-feeling macOS Markdown editor with dual editing views"
  homepage "https://github.com/your-org/monospire"

  auto_updates true
  depends_on macos: ">= :ventura"

  app "Monospire.app"

  zap trash: [
    "~/Library/Application Support/Monospire",
    "~/Library/Preferences/com.monospire.app.plist",
    "~/Library/Saved Application State/com.monospire.app.savedState",
  ]
end

