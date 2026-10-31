# Viti for Windows

A project page for any GitHub repository: boards (post-its, text, images, drawings, notes with LaTeX, PDFs), a chat for every section, a to-do list, report lists, a calendar, an overview of what refers to what, and a progress cairn that grows a stone for everything finished. It is the desktop version of the team's web Viti (`vardengames_dev`), made general: connect any repository you can write to.

- **Home screen:** your projects (repositories). Connect one, open it, give it a new token, or remove it.
- **Branches:** the repository's branches tag to-dos and reports, and each board can have a page per branch.
- **Backup:** everything is backed up to a branch of the repository of its own, `viti-data` (an orphan branch; your code is never touched). Opening a project on a new computer fetches it from there.
- **Look:** light, dark or as Windows is set, and any accent colour (Settings, or Appearance on the home screen).

## Using it

Run `dist/Viti-Setup-0.1.0.exe` (installs for you only, no admin rights), or `dist/Viti-0.1.0-portable.exe` (runs as it is). The builds are not code-signed yet, so Windows SmartScreen asks once: **More info → Run anyway**.

Connecting a repository needs a **fine-grained token**: GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: only that repository. Permissions: **Contents: Read and write**. The home screen has the same steps. Tokens are kept encrypted with Windows' protection for your user, in `%APPDATA%\Viti`, and only ever sent to GitHub.

## How it is built

- `app/main.js`: the Electron window. Starts the local server, gives the window its key, keeps tokens encrypted (safeStorage). F5 reloads, F12 opens the developer tools, Ctrl + / Ctrl − zoom.
- `app/server.js`: the app's server, on 127.0.0.1 only (port 47821, or another if that is taken). The home screen's API (`/app/*`), the open project's pages (`public/`), API and live connection (`/api/*`). Every `/app` and `/api` request needs the window's key (a cookie set at start), so no other program or web page can use it.
- `app/ui/`: the home screen.
- `server/`: Viti's server, from the web version. `hub.js` is the Durable Object that holds a project; `do-shim.js` gives it what Cloudflare would (node:sqlite with the same API, transactions, the backup's timer, the live connections); `host.js` bridges Node's HTTP server and WebSockets to it. One SQLite file per project in `%APPDATA%\Viti\projects\<id>`.
- `public/`: the pages, from the web version. `css/tokens.css` (the colours of both themes and the accent), `css/app.css` (the layout), `css/desktop.css` (the look), `theme.js` (puts the theme on the page before it draws).

## Working on it

```bash
npm install
npm start          # the app
npm run dev        # the server alone: http://127.0.0.1:8795/dev-login in a browser
npm run dist       # dist/Viti-Setup-<version>.exe and dist/Viti-<version>-portable.exe
```

npm 11 asks before running packages' install scripts: `npm approve-scripts electron electron-winstaller` (Electron's downloads the program itself).

## Not there yet

- **Working together live.** Each computer has its own copy and backs it up to `viti-data`; it does not yet take in what others back up while it is open (a new computer gets everything when it first opens the project). Until two-way sync is in, one person per project (or taking turns) is safe; two people writing at once would overwrite each other's backup.
- **Code signing**, so SmartScreen does not ask.
- **Updates** inside the app (for now: install the new version over the old one; your projects are kept).
