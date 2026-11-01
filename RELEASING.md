# Releasing a new version

Viti updates itself from this repository's GitHub Releases. GitHub builds them: the Windows, Mac and Linux
versions (`.github/workflows/release.yml`), so no Mac and no token are needed on your computer.

1. Raise `version` in `package.json` (for example `0.7.0` → `0.7.1`), commit and push.
2. Tag that commit with the version and push the tag:

   ```
   git tag v0.7.1
   git push origin v0.7.1
   ```

GitHub then builds all three (about 10 minutes, under **Actions**) and publishes release `v0.7.1` with the
installers, the portable version, the Mac `.dmg` files, the Linux AppImage and `.deb`, and `latest.yml` / `latest-linux.yml` (what installed copies read to find
the update). The text of the release is `.github/release-notes.md`.

Every push to `main` that changes the app also builds all three (without releasing), to show they still
build; the files are under that run's **Artifacts** for a week.

Installed Windows copies and Linux AppImages find the new version within a few hours (or at once from **About › Updates › Look
now**), download it, and put it in when Viti restarts. Portable, Mac and .deb copies show a bar with a download link.

To try an update without publishing: build, put `latest.yml` (with a higher `version:`) and the installer in a
folder served over HTTP, and start the built `Viti.exe` with `VITI_UPDATE_URL` set to that address.

(`npm run release`, with a token in `GH_TOKEN`, still publishes a Windows-only release from your own computer.)
