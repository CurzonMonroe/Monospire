cask "monospire" do
  version "1.2.5"
  sha256 "d24ab6a9433900f97a0c970e360f2194d5315fb486ebeb1fec9ee285119dd103"

  url "https://github.com/CurzonMonroe/Monospire/releases/download/v1.2.5/Monospire-1.2.5-arm64.dmg"
  name "Monospire"
  desc "A focused Markdown editor"
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
