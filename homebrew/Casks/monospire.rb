cask "monospire" do
  version "2.1.0"
  sha256 "84ac717c1e1b2df8b4b1ed1543541b3d8033333a502a1e2eb50c9bd9e657b976"

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
