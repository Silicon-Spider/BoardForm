# Saving and backups

Chess Builder runs entirely in your browser, and that is also where it keeps your work. This page explains where your data lives, how to keep it safe, and how to move it between browsers and computers.

## Where your data lives

Everything is stored in your browser's built-in database (IndexedDB), in a database called `chess-builder`:

- **engines** — their blocks or source files, options and the last compiled build,
- **networks** — the network files engines load, plus the full-precision weights and optimizer state needed to keep training them,
- **datasets** — training positions, stored in chunks,
- **games** and **matches**, **training runs** with their charts and logs, and your **settings**.

Nothing is uploaded to a server. The data belongs to this browser profile on this computer: another browser, another profile or another device starts empty. If you open Chess Builder in several tabs, they share the same data and changes made in one tab show up in the others.

## Saving happens automatically

There is no Save button to forget. Edits to blocks and code, new engines, finished games, match results and training progress are written to the database as they happen, so closing the tab or reloading the page loses nothing.

Long jobs save checkpoints as they run. Training runs with **Keep training when I reopen the app** switched on continue by themselves when you open the app again; other interrupted runs, dataset jobs, Arena matches and unfinished games on the Play page wait for you to resume them (see [NNUE networks](#/help/nnue?section=running-in-the-background)).

## Keeping your data safe

Browsers may delete a website's data on their own when the computer runs low on disk space — unless the site has been granted **persistent storage**. Chess Builder asks for it the first time it starts. Chrome and Edge decide by themselves (for example based on how much you use the site); Firefox may ask you.

**Storage & data** in [Settings](#/settings?section=storage) shows how much space Chess Builder uses, what is stored, and whether your data is persistent — **Keep my data** asks the browser for persistent storage if it hasn't granted it yet.

Your data is also deleted when you clear your browser's history or site data for this site, and some browsers — notably Safari — may remove the data of sites you haven't used for a while.

> **Tip** The only copy that is truly safe is one outside the browser. Export a backup from [Settings](#/settings?section=storage) before clearing browser data, switching computers, or after a lot of work.

## Backups

**Export a backup** in [Settings](#/settings?section=storage) → **Storage & data** saves a single JSON file with your engines, networks, matches, training runs and settings.

- **Include saved games** is on by default; switch it off to make the file smaller.
- **Include datasets** is off by default, because datasets can be very large (hundreds of MB). Switch it on when you need them.
- **Restore a backup** adds the file's contents to what is already there: records with the same id are overwritten by the ones in the backup, and everything else you have is kept. A damaged or wrong file is rejected before anything is changed. Backups made in another browser work too.

Compiled builds are stored with engines and come back with a backup, but they are rebuilt automatically whenever they don't match the engine's sources.

## Exporting and importing

You can also move single items:

| What | Export | Import |
| --- | --- | --- |
| An engine | **Export** on its card (or **Export…** in the Workshop's **⋯** menu) downloads one `.json` engine file with the engine's blocks or sources and its network, if it has one. Uploaded WASM engines include their module. | **Import engine** on the [Engines](#/engines) page creates a **new** engine — importing the same file twice gives two copies. If the name is taken, " (imported)" is added. The engine is compiled again on first use. |
| A network | **Export .nnue** in the NNUE Lab (the CBNN format, see [NNUE networks](#/help/nnue?section=files)). | **Import .nnue** on the Lab's Networks page. |
| A dataset | **Export .cbds** in the NNUE Lab. | **Import** on the Lab's Datasets page: `.cbds` files, or text files with one `FEN \| score \| result` line per position. |
| A game | **Download PGN** from the Play page's **Saved games**. | **Import PGN** (in **Saved games**, or **Import PGN…** in Analysis) opens a game on the analysis board. |

An engine file is the easiest way to share an engine with a friend: they import it into their own Chess Builder.

## Clearing data

- **Delete single items** where you see them: engines on the Engines page, networks and datasets in the NNUE Lab, games in **Saved games**, matches in the Arena. Every deletion asks for confirmation first. A network or dataset that a running job is using can't be deleted until the job is finished or stopped.
- **Deleting an engine** keeps the games it played and the network it used. **Deleting a network** doesn't delete the engines that use it: those engines can't start any more and say so until you choose another network for them.
- **Restore starter engines** in [Settings](#/settings?section=storage) → **Storage & data** brings back fresh copies of the starter engines you deleted or changed (Blocky, Classic and Sprout); your own engines, and the starters you changed, are kept as they are.
- **Delete all data** in [Settings](#/settings?section=danger) → **Danger zone** deletes every engine, network, dataset, saved game, match, training run and setting stored in this browser. The starter engines are added again afterwards and your colour theme is kept, but nothing else comes back — export a backup first.

## Private windows

In a private or incognito window the database works normally, but the browser deletes it when you close the window, and it may allow much less space. Export a backup or engine file before closing the window if you want to keep anything.

## How much space things take

| Item | Typical size |
| --- | --- |
| A compiled engine | about 75 KB for the template engine |
| A network with 128 hidden neurons | about 1.4 MB with its training state (the `.nnue` file alone is 197 444 bytes) |
| A dataset | 32 bytes per position — one million positions take 32 MB |
| A saved game | a few KB |

Datasets are usually what fills the storage. Delete or export old ones you no longer need.
