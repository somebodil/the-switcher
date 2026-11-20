# The Switcher

Two dialogs for [Obsidian](https://obsidian.md) that take you where you want to be, without leaving the keyboard.

- **Go to file** finds a file by its name, an alias, or its folder.
- **Find in files** finds a text in your notes and shows the note around it.

In both, you pick a result and open it in the current tab or in a new one. Paths you never want to see are hidden with regular expressions, and each dialog remembers its own.

There are no settings. Everything the plugin does is on this page.

## Requirements

- Obsidian 1.8.7 or later
- The desktop app. The plugin does not run on mobile.

## Installation

The Switcher is not in the community plugin directory of Obsidian, so you install it by hand.

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/somebodil/the-switcher/releases/latest).
2. In your vault, create the folder `.obsidian/plugins/the-switcher/` and put the three files in it. `.obsidian` is a hidden folder.
3. Restart Obsidian.
4. Go to **Settings → Community plugins**. If community plugins are still turned off, turn them on. Then switch on **The Switcher** in the list of installed plugins.

To update, replace the three files with the ones from a newer release and restart Obsidian.

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat), it can install and update the plugin for you: add `somebodil/the-switcher` as a beta plugin.

## Getting started

The plugin adds two commands:

- **The Switcher: Go to file**
- **The Switcher: Find in files**

Neither has a hotkey until you give it one under **Settings → Hotkeys**. Until then, run them from the command palette.

## Go to file

The dialog lists the files of your vault, of every type. The file you are looking at is left out, because you are already there.

### What to type

Words are separated by spaces, and a file has to match all of them. Upper and lower case are the same, and spaces inside names do not count: `alphabeta` finds `Alpha Beta`.

| You type       | You get                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `alpha`        | Files with `alpha` in the name, in an alias, or in the folder path       |
| `alpha beta`   | Files that match both words, in any order                                |
| `"alpha beta"` | Files that match the two words next to each other                        |
| `-alpha`       | Everything except what `alpha` matches                                   |
| `Notes/`       | Files in a folder whose path has `Notes`                                 |
| `Notes/alpha`  | Of those, the files with `alpha` in the name or in an alias              |
| `<cd>`         | Stands for the folder of the file you are looking at, as in `<cd>/alpha` |

- Files other than Markdown notes show their extension and are found by it. `png` lists the PNG images.
- When a word matches an alias, that alias is shown under the name.
- A word is also looked up as a whole in the folder path. `Notes/alpha` therefore lists everything in a folder `Notes/Alpha` as well.

### Order of the results

1. Names and aliases that start with more of the words come first.
2. Then alphabetically. A file is listed under an alias when the first word matches that alias and not the name.
3. Then Markdown notes before other files.
4. Then recently opened files.
5. Then recently modified files.

Emoji are skipped in steps 1 and 2, so `📝 Memo` starts with `memo` and is listed under M.

## Find in files

Type a text, and the dialog lists every line of your Markdown notes that has it, with the name of the note and the number of the line.

- The text is taken as you type it, spaces included. There are no wildcards and no operators.
- Upper and lower case are the same.
- A line is listed once, however often it has the text.

The right side shows the note around the selected line, with the text highlighted. It follows the selection as you move through the results.

Opening a result opens the note at that line, with the text selected.

The results are ordered by note, alphabetically by the name of the note, and within a note from the top line down.

The notes are read when the dialog opens: all of them the first time, and after that only the ones that changed. In a large vault the first time takes a moment, and the dialog says `Reading the notes...` until it is done.

A search does not hold up your typing. In a large vault it looks at the notes a few at a time, and lists the first lines while it is still looking at the rest. The number of matching lines comes last: it reads `50 / ...` until every note was looked at. A keystroke that changes the text starts the search over.

## Keys

Both dialogs have the same keys. `Mod` is `Ctrl` on Windows and Linux, and `Cmd` on macOS.

| Key                      | What it does             |
| ------------------------ | ------------------------ |
| `↑` `↓`, `Mod+P` `Mod+N` | Move through the results |
| `Enter`                  | Open in the current tab  |
| `Mod+Enter`              | Open in a new tab        |
| `Mod+E`                  | Go to the exclude input  |
| `Mod+S`                  | Go back to the query     |
| `Esc`                    | Close the dialog         |

- A click opens a result in the current tab, and `Mod+click` in a new tab.
- `Home` and `End` move the cursor in the input you are typing in. They do not jump through the results.
- A file that already has a tab does not get a second one. Opening it in a new tab takes you to the tab that is there.
- Up to 50 results are listed. The numbers at the right of the exclude input, such as `50 / 371`, tell how many are listed and how many there are.

## Hiding paths

The input under the query is the exclude input. It takes JavaScript regular expressions, separated by commas. A file is hidden when one of them matches its path, counted from the root of the vault. Upper and lower case are the same.

| Exclude input       | What is hidden                                  |
| ------------------- | ----------------------------------------------- |
| `^Archive/`         | Everything in the top-level folder `Archive`    |
| `(^\|/)_templates/` | Every folder called `_templates`, however deep  |
| `^Archive/, \.png$` | The folder `Archive`, and every PNG image       |
| `daily, weekly`     | Every path with `daily` or `weekly` in it       |

- **It stays.** What you type is saved and is there the next time, also after Obsidian restarts. Empty the input to see everything again.
- **Each dialog has its own.** Hiding a path in one dialog does not hide it in the other.
- **A pattern in the making does no harm.** While a pattern is not a valid regular expression, the input turns red and that pattern is left out. The other patterns still apply. `*.png` is such a pattern: a regular expression cannot start with `*`, so write `\.png$`.
- **A comma can be part of a pattern.** It is not a separator when it is escaped (`\,`), inside square brackets (`[a,b]`), or inside a quantifier (`{1,3}`).

The two exclude inputs are kept as `fileExclude` and `textExclude` in the `data.json` of the plugin. When that file is changed from outside Obsidian, by a sync or by hand, the dialogs use the new values the next time they open.

## Size

You change the size of a dialog with the mouse.

- **Width.** Drag the left or the right side. A dialog stays in the middle of the window, so both sides move.
- **Height.** Drag the lower side. A lower corner changes the width and the height at once.
- **Results and preview.** In **Find in files**, drag the line between the results and the preview to give one of them more room.
- **Back to the start.** Double-click what you dragged, and it is as it was before you changed it.

Each dialog remembers its own size. The sizes are kept on the device and not in `data.json`, so a sync does not carry them to a screen they do not fit.

## Development

You need [Node.js](https://nodejs.org) 24 or later.

```bash
npm install
npm run dev     # rebuilds main.js on every change
npm run check   # type check, lint, and tests
npm run build   # type check, then the main.js of a release
```

- `src/search` holds the searches. They know nothing about Obsidian, so their tests run with plain Node.js.
- `src/ui` holds the dialogs.
- `src/main.ts` adds the two commands and saves the exclude inputs.

To try a build, copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/the-switcher/` in a vault.

## Acknowledgements

- Inspired by Go to File and Find in Files in [IntelliJ IDEA](https://www.jetbrains.com/idea/).
- Some ideas for the query of Go to file, such as `<cd>` for the folder of the file you are looking at, come from [Another Quick Switcher](https://github.com/tadashi-aikawa/obsidian-another-quick-switcher) by Tadashi Aikawa. The Switcher shares no code with it.

## License

[MIT](LICENSE)
