# Install on Mac

**You need:** macOS 12 or later on Apple Silicon (M1 or newer), connected to the internet.
Nothing else needs to be installed first, and you don't need an administrator password.

1. Open **Terminal**: press ⌘ + Space, type `Terminal`, then press Enter.
2. Paste this line and press Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.sh | sh
   ```

3. You'll see steps like *Downloading…*, *Unpacking…* and *Installing version 0.1.0…*. When it
   says **"Scrappy Records is installed"**, the app opens in your browser.
4. From now on, open **Scrappy Records** from the *Applications* folder in your home folder
   (Finder → Go → Home → Applications). It has an orange circle with a ₹ on it. You can drag it
   to the Dock.

The first time the app saves a backup, macOS may ask whether **Scrappy Records** (or Terminal)
may access files in your Documents folder. Click **Allow**: that's where the backups go. If you
click *Don't Allow*, the app still works, and keeps its backups next to your data instead (see
[backups](backup-and-restore.md)).

## Where things live

| What | Where |
|---|---|
| The app | `~/Library/Application Support/ScrappyRecords/app` |
| **Your data** | `~/Library/Application Support/ScrappyRecords/data/records.db` |
| Daily backups | `~/Documents/ScrappyRecords Backups` |
| Log file (for troubleshooting) | `~/Library/Application Support/ScrappyRecords/logs/server.log` |
| The app icon | `~/Applications/Scrappy Records.app` |

## Update

Run the same line again. Your data is kept, and a backup is taken first. To install a specific
version: `curl -fsSL <the same address> | sh -s -- --version v0.1.0`.

## If something goes wrong

- The installer prints **"Sorry, Scrappy Records was NOT installed. Your data has not been
  changed."** with the reason. Run the line again; if it keeps failing, see
  [troubleshooting](troubleshooting.md).
- If the app shows a message instead of opening, it names the log file above; send that file to
  whoever set this up.
- For errors in a Terminal window, double-click
  `~/Library/Application Support/ScrappyRecords/app/Start Scrappy Records.command`.

## Uninstall

1. Delete `~/Applications/Scrappy Records.app`.
2. Delete `~/Library/Application Support/ScrappyRecords`. **This deletes your data**, so keep the
   backups folder if you might want it back.
