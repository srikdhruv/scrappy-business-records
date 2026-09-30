# Updating to a new version

Your data is **always kept** when you update. A backup is also taken automatically first.

## Windows

1. Close the Scrappy Records browser tab.
2. Open PowerShell: press the **Windows key**, type `PowerShell`, and press **Enter**.
3. Paste the same line you used to install, then press **Enter**:

   ```powershell
   [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
   ```

4. Wait for **"Scrappy Records is installed"**. The new version opens.

It doesn't matter if the app is still open: the installer closes it first.

## Mac

Run the install line from [install-mac.md](install-mac.md) again.

## What happens behind the scenes

1. The newest release is downloaded from GitHub to the temporary folder, and unpacked next to
   the current version (`app.new`).
2. The running app, if any, is asked to stop, and finishes what it's doing. Anything still
   running after 10 seconds is stopped by force. Only programs started from the app's own
   folders are stopped.
3. A copy of your data is saved to
   `Documents\ScrappyRecords Backups\records-pre-update-<date>-<time>.db`, with the *old*
   version's `python -m app.backup --reason pre-update`, else the new version's. If neither
   works, the installer copies the file itself, together with any `records.db-journal`, into
   the backups folder or `data\backups`. If nothing works, it stops without changing anything.
4. The new version is swapped in: `app` becomes `app.old`, `app.new` becomes `app`, and
   `app.old` is deleted. If the swap fails, the old version is put back. The `data` folder is
   never touched.
5. The Desktop shortcut is recreated and the downloaded zip is deleted. (If the shortcut can't be
   made, the installer says so in yellow, but the update itself has worked.)
6. The new version opens. If its database layout changed, it takes another backup
   (`records-pre-migration-…`) before upgrading the database.

## Which version do I have?

Look at the bottom of the app's side menu (*Version 0.1.0*; it's hidden when the browser window
is very narrow, so widen it). Or open `http://127.0.0.1:8765/api/health` in the browser. It's
also in the `VERSION` file in the app folder.

## Going back to an older version

Ask whoever set this up. They can install a specific release with `-Version v0.1.0`; see the
[release runbook](release.md#rolling-back).
