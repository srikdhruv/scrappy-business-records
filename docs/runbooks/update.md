# Updating to a new version

Your data is **always kept** when you update. A backup is also taken automatically first.

## Windows

1. Close the Scrappy Records browser tab.
2. Open PowerShell: press the **Windows key**, type `PowerShell`, and press **Enter**.
3. Paste the same line you used to install, then press **Enter**:

   ```powershell
   irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
   ```

4. Wait for **"Scrappy Records is installed"**. The new version opens.

It doesn't matter if the app is still open: the installer closes it first.

## Mac

Run the install line from [install-mac.md](install-mac.md) again.

## What happens behind the scenes

1. The newest release is downloaded from GitHub to the temporary folder.
2. The running app, if any, is stopped. Only programs started from the app's own folder are
   stopped.
3. A copy of your data is saved to
   `Documents\ScrappyRecords Backups\records-pre-update-<date>-<time>.db`, using the *old*
   version's `python -m app.backup --reason pre-update`. If that doesn't work, the installer
   copies the file itself. If neither works, it stops without changing anything.
4. The new version is unpacked next to the old one (`app.new`), then swapped in: `app` becomes
   `app.old`, `app.new` becomes `app`, and `app.old` is deleted. If the swap fails, the old
   version is put back. The `data` folder is never touched.
5. The Desktop shortcut is recreated and the downloaded zip is deleted.
6. The new version opens. If its database layout changed, it takes another backup
   (`records-pre-migration-…`) before upgrading the database.

## Which version do I have?

Open `http://127.0.0.1:8765/api/health` in the browser, or look at the bottom of the app's side
menu. It's also in the `VERSION` file in the app folder.

## Going back to an older version

Ask whoever set this up. They can install a specific release with `-Version v0.1.0`; see the
[release runbook](release.md#rolling-back).
