# Backups and restore

## What is backed up, and when

All your data is in one file:
`C:\Users\<you>\AppData\Local\ScrappyRecords\data\records.db`.

Copies are saved automatically to **`Documents\ScrappyRecords Backups`**:

| When | File name | Kept for |
|---|---|---|
| Once a day: when the app starts, and at midnight (or on waking) while it runs | `records-2026-10-05.db` | 30 days |
| Before an update | `records-pre-update-20261005-101500.db` | Kept until you delete it |
| Only if an update's new version upgraded the records and then didn't start: the records as it left them, set aside when the pre-update backup was put back | `records-failed-update-20261005-101530.db` | Kept until you delete it |
| Before a database upgrade | `records-pre-migration-20261005-101500.db` | Kept until you delete it |
| Before adding an Excel upload (**Upload Excel** → **Add**) | `records-pre-import-20261005-101500.db` | Kept until you delete it |
| Before turning labels into batches ("Create batches from existing labels") | `records-pre-batches-20261005-101500.db` | Kept until you delete it |
| When someone takes one by hand | `records-manual-20261005-101500.db` | Kept until you delete it |

The daily backup is taken when the app starts, and the running app takes the next one itself
when the date changes, so a laptop that only ever sleeps still gets one a day. There's none on
a day the laptop is off. Only the `records-YYYY-MM-DD.db` files are ever deleted automatically
(the oldest ones, beyond 30); anything else in the folder is left alone.

If the backups folder can't be written (Windows' "Controlled folder access", a OneDrive problem,
or a Mac where access to Documents was refused), backups go to the `backups` folder next to your
data instead: `%LOCALAPPDATA%\ScrappyRecords\data\backups`.

Rarely, a pre-update backup is a plain file copy (the installer says "file copy"). It may then
come with a second file of the same name ending in `-journal`. Keep the two together.

**After an update that didn't start.** If a new version upgraded the records and then crashed
before it ever opened, the installer puts back the pre-update backup by itself (nothing can
have been entered in between) and keeps the records it replaced as
`records-failed-update-….db`. You don't need to do anything. If it says it *couldn't* put
them back, restore the newest `records-pre-update-….db` as below (the app may not open until
you do); nothing is lost.

> **Extra safety.** If your Documents folder is synced to OneDrive or Google Drive, your backups
> are automatically copied off the laptop too. You can also copy the backups folder to a USB
> stick now and then.

## Restore a backup

1. **Stop the app.** Restart the laptop. That's the simplest way to make sure the app isn't
   running.
   - Developers can instead run:
     `Get-Process pythonw | Where-Object Path -like "$env:LOCALAPPDATA\ScrappyRecords\*" | Stop-Process`
2. Open File Explorer and go to `Documents\ScrappyRecords Backups`. Choose the backup you want
   (the date is in the name) and **copy** it.
3. Go to `C:\Users\<you>\AppData\Local\ScrappyRecords\data`.
   - Tip: paste `%LOCALAPPDATA%\ScrappyRecords\data` into the File Explorer address bar.
4. Rename the current `records.db` to `records-broken.db`, so nothing is lost. If there are
   other files starting with `records.db-` (such as `records.db-journal`), rename them the same
   way (`records-broken.db-journal`), or move them into another folder. Left behind, they would
   be applied to the restored file.
5. Paste the backup here and rename it to **`records.db`**. If the backup came with a
   `-journal` file, paste that too and rename it to `records.db-journal`.
6. Double-click **Scrappy Records** on the Desktop. The app now shows the data from that backup.

## Undo an Excel upload

Adding an upload never changes anything that was already there, but if a whole upload was a
mistake (the wrong file, say), restore the `records-pre-import-…` backup taken just before it,
following **Restore a backup** above. Anything saved after that upload is undone too, so note
it down first. For one or two wrong rows, simply delete them in the app instead.

## Moving to a new laptop

Either way works:

- **The backup file** (exactly as it was, nothing left behind):
  1. Install the app on the new laptop ([install-windows.md](install-windows.md)).
  2. Follow **Restore a backup** above, using the newest backup copied from the old laptop, for
     example via a USB stick.
- **The Excel file** (no File Explorer steps):
  1. On the old laptop, click **Download everything** at the bottom of the side menu, and copy
     the file to the new laptop.
  2. Install the app on the new laptop, go to **Students** → **Upload Excel**, choose the file,
     check the preview and click **Add**. Every student, fee (months away included), payment and
     unassigned payment comes back.

## For developers

- Backups use SQLite's online backup API (`sqlite3.Connection.backup`), so they are consistent
  even while the server is running. The live file is opened read-write (never created), so if
  a crash left a hot `records.db-journal`, SQLite rolls the unfinished change back first, like
  the app would. Each copy is written to a `.partial` file first and renamed when complete. The
  code is in `backend/app/backup.py`; the date-change backup is in `backend/app/lifetime.py`.
- If the daily backup fails, the error is logged and the app still opens. If the pre-migration
  backup fails, the app does **not** start, rather than upgrade a database it couldn't copy. If
  the pre-import backup fails, nothing from the upload is added (the owner sees "Couldn't save a
  backup first, so nothing was added"). It's taken by `app.services.imports.commit` just before
  it adds anything, and not at all when there's nothing to add.
- To take a backup manually with the bundled Python (it prints where it saved it):
  ```powershell
  & "$env:LOCALAPPDATA\ScrappyRecords\app\python\python.exe" -m app.backup --reason manual
  ```
  On a Mac:
  `~/Library/Application\ Support/ScrappyRecords/app/python/bin/python3 -m app.backup --reason manual`.
  The installers run the same command with `--reason pre-update`, using the *installed*
  version's Python (they come from `main`, the app may be older), so this command must keep
  working in every release.
