## Download

**Windows**
- `Viti-Setup-….exe`: the installer. Installed Viti updates itself.
- `Viti-…-portable.exe`: runs without installing (tells you when there is a new version).

The first time, Windows may say *"Windows protected your PC"*: click **More info › Run anyway**.

**Mac**
- `Viti-…-mac-arm64.dmg`: Macs with Apple silicon (M1 and later).
- `Viti-…-mac-x64.dmg`: Macs with an Intel processor.

Open the .dmg and drag Viti to Applications. Viti is not signed by Apple, so the first time macOS says it *could not verify* Viti: click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to Viti. If it says Viti *is damaged*, open Terminal and run `xattr -dr com.apple.quarantine /Applications/Viti.app`, then open it again.

On a Mac, Viti tells you when there is a new version to download.
