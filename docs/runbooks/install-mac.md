# Install on Mac

**You need:** macOS 12 or later on Apple Silicon (M1 or newer). Nothing else needs to be
installed first.

1. Open **Terminal**: press ⌘ + Space, type `Terminal`, then press Enter.
2. Paste this line and press Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.sh | sh
   ```

3. When you see **"Scrappy Records is installed"**, the app opens in your browser.
4. From now on, open **Scrappy Records** from your *Applications* folder (the one in your home
   folder), or keep it in the Dock.

## Where things live

| What | Where |
|---|---|
| The app | `~/Library/Application Support/ScrappyRecords/app` |
| **Your data** | `~/Library/Application Support/ScrappyRecords/data/records.db` |
| Daily backups | `~/Documents/ScrappyRecords Backups` |
| Launcher | `~/Applications/Scrappy Records.command` |

## Update

Run the same line again. Your data is kept.

## Uninstall

1. Delete `~/Applications/Scrappy Records.command`.
2. Delete `~/Library/Application Support/ScrappyRecords`. **This deletes your data**, so keep the
   backups folder if you might want it back.
