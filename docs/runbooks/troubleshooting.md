# Troubleshooting

Start with the simplest fix: **restart the laptop, then double-click Scrappy Records.** It solves
most problems.

## The app doesn't open when I double-click the shortcut

1. Wait 10 seconds. The first start after switching on the laptop can take a moment (the very
   first start after installing can take up to a minute).
2. Open your browser and go to `http://127.0.0.1:8765`.
3. If a message box appeared, it says what went wrong in plain words (see below) and names the
   log file.
4. If it still doesn't load, open the log file:
   `%LOCALAPPDATA%\ScrappyRecords\logs\server.log` (paste the path into File Explorer's address
   bar). Send the last lines to whoever set this up. On a Mac it's
   `~/Library/Application Support/ScrappyRecords/logs/server.log`.
5. **Developers:** run `Start Scrappy Records.cmd` from the `app` folder to see errors in a
   console. You can also run the server in the foreground:
   ```powershell
   cd "$env:LOCALAPPDATA\ScrappyRecords\app"
   .\python\python.exe -m app
   ```
   The logs folder also has `server-console.log` (the server's raw output since it last started)
   and `server.log.1`, `server.log.2` (older log entries).

## Messages the app can show

| Message starts with | What it means | Fix |
|---|---|---|
| "Scrappy Records couldn't start because another program is using its connection (port 8765)" | Something else is using the app's port | See the next section |
| "Scrappy Records is taking too long to start" | The server didn't answer within a minute | Restart the laptop and try again. If it keeps happening, send `server.log` |
| "Scrappy Records couldn't start" | The server stopped straight away | Send `server.log`; it has the reason |
| "Scrappy Records is running, but the browser didn't open" | No default browser responded | Open the browser and go to `http://127.0.0.1:8765` |

## "Port 8765 is already in use"

Another program is using the app's port.
- Restarting the laptop usually fixes it.
- **Developers:** find the program with `netstat -ano | findstr 8765`. To use a different port,
  set a user environment variable `SCRAPPY_PORT=8766`, then open the app again.

## The page shows old data or looks broken after an update

Press **Ctrl + F5** in the browser to force a full reload.

## The install line shows an error

The installer ends with **"Sorry, Scrappy Records was NOT installed. Your data has not been
changed."**, a hint, and the details. Nothing was changed, so it's safe to run the line again.

| Details contain | Fix |
|---|---|
| `Could not create SSL/TLS secure channel` | Your Windows is very old. Run Windows Update, then try again. |
| `The remote name could not be resolved` / `Unable to connect` | You're not connected to the internet. Connect, then try again. |
| `Access to the path ... is denied` / `being used by another process` | The app or an antivirus scan is holding a file. Restart the laptop, then run the install line again. |
| `404` / `Not Found` | No release has been published yet (or that version doesn't exist). Ask whoever set this up. |
| `The download looks incomplete` | The download was cut short. Run the line again. |

If the `app` folder ends up missing after a failed update, running the install line again fixes
it. Your data is in the separate `data` folder and is never touched by the installer.

## Antivirus

The installer only downloads a zip from GitHub and unzips it into your user folder. If your
antivirus quarantines `pythonw.exe` from `AppData\Local\ScrappyRecords`, mark it as allowed and
run the install line again.

## Mac: "Scrappy Records would like to access files in your Documents folder"

Click **Allow**: backups are saved in `Documents/ScrappyRecords Backups`. If you clicked *Don't
Allow*, the app keeps working and saves backups in
`~/Library/Application Support/ScrappyRecords/data/backups` instead. To change your answer: System
Settings → Privacy & Security → Files and Folders.

## I deleted something by mistake

Restore yesterday's backup. See [backup-and-restore.md](backup-and-restore.md). Anything entered
since that backup will need to be entered again.

## Where's my data?

`%LOCALAPPDATA%\ScrappyRecords\data\records.db`. Backups are in
`Documents\ScrappyRecords Backups`.
