# Releasing a new version

Viti updates itself from this repository's GitHub Releases. To publish one:

1. Raise `version` in `package.json` (for example `0.7.0` → `0.7.1`), commit and push.
2. In PowerShell, in this folder, with a GitHub token that may write to the repository's contents (a fine-grained token with **Contents: Read and write** on ionodev/viti, or a classic token with `repo`):

   ```powershell
   $env:GH_TOKEN = "<the token>"; npm run release
   ```

   This builds the installer and the portable version and publishes them as release `v<version>`, with `latest.yml` (what installed copies read to find the update).

Installed copies find the new version within a few hours (or at once from **About › Updates › Look now**), download it, and put it in when Viti restarts. Portable copies show a bar with a download link.

To try an update without publishing: build, put `latest.yml` (with a higher `version:`) and the installer in a folder served over HTTP, and start the built `Viti.exe` with `VITI_UPDATE_URL` set to that address.
