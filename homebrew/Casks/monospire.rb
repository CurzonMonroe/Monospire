cask "monospire" do
  version "2.3.0"
  sha256 "ae5d06de0fb594d42db54e966b1f078dd3a911d720250303b703197759a35291"

  url "https://github.com/CurzonMonroe/Monospire/releases/download/v#{version}/Monospire-#{version}-arm64.dmg"
  name "Monospire"
  desc "A focused Markdown editor"
  homepage "https://github.com/CurzonMonroe/Monospire"

  depends_on macos: ">= :big_sur"

  app "Monospire.app"
  binary "#{appdir}/Monospire.app/Contents/Resources/app/scripts/monospire-cli", target: "monospire"

  zap trash: [
    "~/Library/Application Support/Monospire",
    "~/Library/Preferences/com.monospire.app.plist",
    "~/Library/Saved Application State/com.monospire.app.savedState",
  ]
end
