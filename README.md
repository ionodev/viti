# Viti

**A shared workspace for your project on GitHub.** Pick a repository and Viti gives it boards to think on, a chat, a to-do list, bug reports, a calendar and a mailbox, all in one window. Everything you add is backed up to the repository itself, so it stays with your project.

Viti is a Windows app. It is free and open source.

## Getting started

1. **Download** the latest version from the [Releases](https://github.com/ionodev/viti/releases) page: the installer (`Viti-Setup-….exe`), or the portable version that runs without installing.
2. **Open it.** Windows may say *"Windows protected your PC"* the first time, because the app is not signed with a paid certificate. Click **More info → Run anyway**.
3. **Sign in with GitHub.** Viti shows a short code and opens GitHub in your browser. Enter the code there and approve Viti.
4. **Pick a repository** from the list of the ones you can write to. That's your first project.

You can add as many projects as you like, and switch between them on the home screen.

## What you can do

- **Boards.** An endless canvas for each section: sticky notes, text, images, drawings, highlighted words, groups, and notes with headings and equations. Drag, zoom and arrange things as you think.
- **Chat.** Every section has its own chat. Quote a piece of text from a board, or point to a note, a task or a message, and it links straight to it. Write *@name* to get someone's attention.
- **To do.** Write a task and press Enter. Give it a priority (and with it a deadline), tag it with a branch of your repository, and tick it off when it's done.
- **Reports.** Lists for bugs or anything else you collect, with screenshots. Open, Closed and Trash, side by side.
- **Calendar.** Deadlines show up by themselves, and you can label any day and point it at anything in the project.
- **Progress.** Every finished task adds a stone to a cairn that keeps growing. Click a stone to go back to the task it stands for.
- **Overview.** A map of what refers to what across the project.
- **Mail.** Link a mailbox to a Gmail label and the emails in it come into Viti, where the whole project can read them. Reply or write new emails right from Viti.
- **Search everything** with **Ctrl+K**, and press **?** to see all keyboard shortcuts.
- **Make it yours.** Light or dark, and any accent colour you like (Settings, or *Appearance* on the home screen).

## Your data

- **On your computer:** each project is kept in your Windows user folder, so Viti is fast and works offline too.
- **On GitHub:** everything is also backed up to your repository, in a branch of its own called `viti-data`. Your code and your other branches are never touched. Opening the project on another computer brings it all back.
- **Your sign-ins** (GitHub, and the Gmail app password) stay on your computer, encrypted, and are only ever sent to GitHub and Google.
- **Mail and public repositories:** because everything in a project is backed up to the repository, Viti does not let you link a mailbox in a public repository, where anyone could read it.

## Mail with Gmail

1. Turn on 2-Step Verification in your Google account, then create an **app password** (Google account › Security › App passwords). Call it "Viti".
2. In Gmail, make a **label** (for example *Viti*) and a filter that puts the right emails in it.
3. In Viti, add a **Mailbox** to your project, click **Link a label**, connect your Gmail with the app password, and pick the label.

New mail comes in every couple of minutes while Viti is open. Emails you send yourself appear under **Sent**. Viti never moves or deletes anything in your Gmail.

## Good to know

- **Working together:** several people can use the same project, but for now not at the same time. Each computer keeps its own copy and backs it up, and the last one to back up wins. Live syncing between computers is on its way.
- **Organisations on GitHub** may have to approve Viti once before their repositories show up (organisation settings › Third-party access).

## Problems and ideas

Something not working, or an idea for Viti? Open an [issue](https://github.com/ionodev/viti/issues).

## Building it yourself

Viti is an Electron app. With [Node.js](https://nodejs.org) installed:

```
npm install
npm start
npm run dist
```

`npm start` runs it, and `npm run dist` makes the Windows installer and portable version in `dist/`.
