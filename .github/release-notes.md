## Download

| | File | |
|---|---|---|
| **Windows** | `Viti-Setup-….exe` | Run it. If Windows says *Windows protected your PC*: **More info › Run anyway**. Updates itself. |
| **Mac** (Apple silicon and Intel) | `Viti-…-mac.dmg` | Drag Viti to Applications and open it. The first time macOS can't verify it: click **Done**, then **System Settings › Privacy & Security › Open Anyway**. Tells you when there is a new version. |
| **Linux** (any distribution) | `Viti-…-linux-….AppImage` | `chmod +x` it (or Properties › Allow executing) and open it. On Ubuntu 22.04+ it may first need `sudo apt install libfuse2` (24.04: `libfuse2t64`). Updates itself. |

**Also here:** `Viti-…-portable.exe` runs on Windows without installing; `Viti-…-linux-….deb` installs on Ubuntu and Debian (`sudo apt install ./Viti-*.deb`). If a Mac says Viti *is damaged*, run `xattr -dr com.apple.quarantine /Applications/Viti.app` in Terminal.
