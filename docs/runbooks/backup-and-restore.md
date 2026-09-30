# Backups and restore

## What is backed up, and when

All your data is in one file:
`C:\Users\<you>\AppData\Local\ScrappyRecords\data\records.db`.

Copies are saved automatically to **`Documents\ScrappyRecords Backups`**:

| When | File name | Kept for |
|---|---|---|
| The first time the app opens each day | `records-2026-10-05.db` | 30 days |
| Before an update | `records-pre-update-20261005-101500.db` | Kept until you delete it |
| Before a database upgrade | `records-pre-migration-20261005-101500.db` | Kept until you delete it |

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
4. Rename the current `records.db` to `records-broken.db`, so nothing is lost.
5. Paste the backup here and rename it to **`records.db`**.
6. Double-click **Scrappy Records** on the Desktop. The app now shows the data from that backup.

## Moving to a new laptop

1. Install the app on the new laptop ([install-windows.md](install-windows.md)).
2. Follow **Restore a backup** above, using the newest backup copied from the old laptop, for
   example via a USB stick.

## For developers

- Backups use SQLite's online backup API (`sqlite3.Connection.backup`), so they are consistent
  even while the server is running. The code is in `backend/app/backup.py`.
- To take a backup manually with the bundled Python:
  ```powershell
  & "$env:LOCALAPPDATA\ScrappyRecords\app\python\python.exe" -m app.backup --reason manual
  ```
