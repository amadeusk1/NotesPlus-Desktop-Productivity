# Notes+

I loved the simplicity and the usability of the Notepad app on Windows 11. I had some problems with it, though:

1. I didn't have it on my Windows 10 computer (I didn't check to see if I can get it, tbh).
2. I wanted more functionality, such as a tasks screen, without losing the simplicity of Notepad.

So what did I do? 
I built my own version: Notes+

It looks like Windows 11 Notepad (dark theme, tabs, live Markdown) and it runs on Windows 10 and 11. With a task screen that opens when the pencil icon is pressed, that stays as simple as the rest of the editor.

## Screenshots

**Notes**

The editor with tabs, menus, and live formatting.

![Notes](docs/screenshots/notes.png)

**Tasks**

A task list with due dates. Open a task for details.

![Tasks](docs/screenshots/tasks.png)

**Settings**

Theme, font, and how files open.

![Settings](docs/screenshots/settings.png)

## Download

[Download Notes+ for Windows](https://github.com/amadeusk1/NotesPlus-Desktop-Productivity/releases/download/v1.1.0/NotesPlus-1.1.0.exe)

No install. Open the `.exe` and it runs.

## Run from source

If you want to work on the code, install Node.js, then:

```
npm install
npm run dev
```

## Features

- Open files in tabs
- Save as txt or md
- Switch between formatted view and Markdown syntax
- Find and replace
- Restore your last session
- Tasks: add, check off, due dates, and a description pane
