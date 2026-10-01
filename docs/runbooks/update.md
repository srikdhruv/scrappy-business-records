# Updating to a new version

Your data is **always kept** when you update. A backup is also taken automatically first.

## From inside the app (the usual way)

From version 0.2.0 on, the app tells you when a new version is out, and updates itself.

1. When a new version is ready, a note appears at the top of every page: **"A new version
   (0.3.0) is ready."** The **⚙ Settings** button at the bottom left gets a small dot too.
2. Click **See what's new** if you'd like to read what changed.
3. Click **Update now**. The app asks first: *"Updating takes about a minute. Your records are
   kept and backed up first. The app will reopen by itself."* If something you typed isn't saved
   yet (in this window or another Scrappy Records window), it says so: save it first.
4. Click **Update now** again. The page says **"Updating… the app will reopen in a minute"**.
   Leave the window open. When the new version is ready, the page reloads by itself and says
   **"Updated to version 0.3.0"**.

Not a good moment? Click **Not now**: the note goes away until the next version, and **⚙
Settings → About** still has **Update now**. About also has **Check for updates**, to look
straight away (the app looks by itself when it starts and twice a day, when the laptop is
online).

If it says **"The update didn't finish"**, nothing is lost: the old version is still there,
with your records as they were. See [troubleshooting](troubleshooting.md#the-update-didnt-finish).

## The pasted line (the first install, and the fallback)

Use this if the app can't update itself: for the update **to** 0.2.0 (the first version with
the button), or if Update now keeps failing.

### Windows

1. Close the Scrappy Records browser tab.
2. Open PowerShell: press the **Windows key**, type `PowerShell`, and press **Enter**.
3. Paste the same line you used to install, then press **Enter**:

   ```powershell
   [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
   ```

4. Wait for **"Scrappy Records is installed"**. The new version opens.

It doesn't matter if the app is still open: the installer closes it first.

### Mac

Run the install line from [install-mac.md](install-mac.md) again.

## What happens behind the scenes

**Update now** ([ADR 0006](../adr/0006-in-app-update.md)) runs the same installer as the pasted
line, taken from the new release itself (so the installer and the version it installs always
match), in the background with no window. Its messages go to `logs\update.log`. Either way:

1. The newest release is downloaded from GitHub to the temporary folder, **checked against the
   release's list of checksums** (`SHA256SUMS`: if it isn't exactly the file that was
   published, it stops, with nothing changed), and unpacked next to the current version
   (`app.new`). (Update now also checks the installer itself the same way before running it.)
2. The running app, if any, is asked to stop, and finishes what it's doing. Anything still
   running after 10 seconds is stopped by force. Only programs started from the app's own
   folders are stopped.
3. A copy of your data is saved to
   `Documents\ScrappyRecords Backups\records-pre-update-<date>-<time>.db`, with the *old*
   version's `python -m app.backup --reason pre-update`, else the new version's. If neither
   works, the installer copies the file itself, together with any `records.db-journal`, into
   the backups folder or `data\backups`. If nothing works, it stops without changing anything.
4. The new version is swapped in: `app` becomes `app.old`, `app.new` becomes `app`. If the swap
   fails, the old version is put back. The `data` folder is never touched.
5. The new version opens, and the installer waits (up to 3 minutes) for it to answer as the
   new version. If its database layout changed, it takes another backup
   (`records-pre-migration-…`) before upgrading the database. **If it doesn't start**, the
   installer puts the old version back (from `app.old`), opens it, and says so (*"The new
   version didn't start, so the previous version was put back"*); the line is also written to
   `logs\update.log`. Otherwise `app.old` is deleted.
6. The Desktop shortcut is recreated and the downloaded zip is deleted. (If the shortcut can't be
   made, the installer says so in yellow, but the update itself has worked.) After **Update
   now**, the page that started it reloads itself, so no second browser tab opens. If the
   update failed after the app was closed, the old version is opened again instead.

## Which version do I have?

**⚙ Settings → About** shows it, and the newest one. It's also at the bottom of the app's side
menu (*Version 0.1.0*; it's hidden when the browser window is very narrow, so widen it), at
`http://127.0.0.1:8765/api/health`, and in the `VERSION` file in the app folder.

## Going back to an older version

Ask whoever set this up. They can install a specific release with `-Version v0.1.0`; see the
[release runbook](release.md#rolling-back). (The app only ever offers a *newer* version.)
