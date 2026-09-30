# Install on Windows

**Who this is for:** the person using the app, or whoever is setting it up for them.
**Time:** about 2 minutes, plus the download.
**You need:** a Windows 10 or 11 laptop connected to the internet. Nothing else needs to be
installed first, and you don't need an administrator password.

## Steps

1. **Open PowerShell.** Press the **Windows key**, type `PowerShell`, and click
   **Windows PowerShell**. A blue or black window opens.

2. **Paste the install line.** Copy this whole line:

   ```powershell
   irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
   ```

   Click inside the PowerShell window, **right-click** to paste, then press **Enter**.

3. **Wait.** You'll see steps like *Downloading…*, *Installing…* and *Creating shortcut…*. When
   it says:

   ```
   Scrappy Records is installed
   ```

   the app opens in your web browser by itself.

4. **Close PowerShell.** You won't need it again.

## Opening the app from now on

Double-click **Scrappy Records** on your Desktop. Your browser opens the app within a few
seconds.

> Tip: in the browser, you can bookmark the page (Ctrl + D). The address is
> `http://127.0.0.1:8765`. The bookmark works whenever the app has been opened since the laptop
> was switched on.

## What got installed, and where

| What | Where |
|---|---|
| The app | `C:\Users\<you>\AppData\Local\ScrappyRecords\app` |
| **Your data** | `C:\Users\<you>\AppData\Local\ScrappyRecords\data\records.db` |
| Daily backups | `Documents\ScrappyRecords Backups` |
| Shortcut | Desktop → **Scrappy Records** |

Nothing is installed system-wide, and nothing runs until you open the app.

## If something goes wrong

- **"Windows protected your PC"** or an antivirus warning: this shouldn't happen with the
  one-line install. If it does, see [troubleshooting](troubleshooting.md#antivirus).
- **Red error text in PowerShell:** take a photo or screenshot of the window and send it to
  whoever set this up. Also see [troubleshooting](troubleshooting.md).

## Uninstall

1. Close the browser tab.
2. Delete the Desktop shortcut.
3. Delete the folder `C:\Users\<you>\AppData\Local\ScrappyRecords`.

**This deletes your data.** Keep the `Documents\ScrappyRecords Backups` folder if you might want
it back.
