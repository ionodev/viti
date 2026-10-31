# Viti for Windows

A project page for any GitHub repository: boards (post-its, text, images, drawings, notes with LaTeX, PDFs), a chat for every section, a to-do list, report lists, a calendar, an overview of what refers to what, and a progress cairn that grows a stone for everything finished. It is the desktop version of the team's web Viti (`vardengames_dev`), made general: connect any repository you can write to.

- **Home screen:** your projects (repositories). Connect one, open it, give it a new token, or remove it.
- **Branches:** the repository's branches tag to-dos and reports, and each board can have a page per branch.
- **Backup:** everything is backed up to a branch of the repository of its own, `viti-data` (an orphan branch; your code is never touched). Opening a project on a new computer fetches it from there.
- **Look:** light, dark or as Windows is set, and any accent colour (Settings, or Appearance on the home screen).

## Using it

Run `dist/Viti-Setup-0.1.0.exe` (installs for you only, no admin rights), or `dist/Viti-0.1.0-portable.exe` (runs as it is). The builds are not code-signed yet, so Windows SmartScreen asks once: **More info → Run anyway**.

**Sign in with GitHub** (top right, or when you connect a repository): Viti shows a short code and opens GitHub; enter it there and approve, and Viti lists the repositories you can write to. Pick one. The sign-in is kept encrypted with Windows' protection for your user, in `%APPDATA%\Viti`, and only ever sent to GitHub. It is Viti's OAuth App (`app/github-app.js`, device flow, no secret); an organisation that restricts third-party apps has to approve it once (Organisation settings → Third-party access).

A repository the sign-in cannot reach can still be connected with a fine-grained token (Contents: Read and write on that repository): "Connect it with a token instead" in the list.

**Mail** (Gmail): make a **Mailbox** (+ New section, or + New mailbox under MAIL) and link it to a Gmail label, with your address and an app password (Google account → Security → 2-Step Verification → App passwords). New mail comes in every couple of minutes while Viti is open; forwarded emails show who wrote them; what you send yourself goes to **Sent**. **Reply** (threaded with the original) and **New email** (✎ on the bar) send from the same account, after a last "Send this email?". Viti never moves or deletes your mail. Accounts and their app passwords stay on this computer, encrypted; the mail in a mailbox is part of the project (backed up to the repository), so Viti refuses mail in a public repository.

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
