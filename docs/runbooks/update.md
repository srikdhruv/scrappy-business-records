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

## Mac

Run the install line from [install-mac.md](install-mac.md) again.

## What happens behind the scenes

1. The newest release is downloaded from GitHub.
2. The running app, if any, is stopped.
3. A copy of your data is saved to `Documents\ScrappyRecords Backups\records-pre-update-<time>.db`.
4. The `app` folder is replaced. The `data` folder is not touched.
5. When the new version starts, it upgrades the database if needed, taking another backup first.

## Which version do I have?

Open `http://127.0.0.1:8765/api/health` in the browser, or look at the bottom of the app's side
menu.

## Going back to an older version

Ask whoever set this up. They can install a specific release with
`install.ps1 -Version v0.1.0`. See the [release runbook](release.md#rolling-back).
