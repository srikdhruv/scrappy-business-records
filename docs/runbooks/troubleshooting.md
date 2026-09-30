# Troubleshooting

Start with the simplest fix: **restart the laptop, then double-click Scrappy Records.** It solves
most problems.

## The app doesn't open when I double-click the shortcut

1. Wait 10 seconds. The first start after switching on the laptop can take a moment.
2. Open your browser and go to `http://127.0.0.1:8765`.
3. If it still doesn't load, open the log file:
   `%LOCALAPPDATA%\ScrappyRecords\logs\server.log` (paste the path into File Explorer's address
   bar). Send the last lines to whoever set this up.
4. **Developers:** run `Start Scrappy Records.cmd` from the `app` folder in a terminal to see
   errors directly. You can also run it in the foreground:
   ```powershell
   cd "$env:LOCALAPPDATA\ScrappyRecords\app"
   .\python\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8765
   ```

## "Port 8765 is already in use"

Another program is using the app's port.
- Restarting the laptop usually fixes it.
- **Developers:** find the program with `netstat -ano | findstr 8765`. To use a different port,
  set a user environment variable `SCRAPPY_PORT=8766`, then open the app again.

## The page shows old data or looks broken after an update

Press **Ctrl + F5** in the browser to force a full reload.

## PowerShell shows red text during install

| Message contains | Fix |
|---|---|
| `Could not create SSL/TLS secure channel` | Your Windows is very old. Run Windows Update, then try again. |
| `The remote name could not be resolved` / `Unable to connect` | You're not connected to the internet. Connect, then try again. |
| `Access to the path ... is denied` | The app is still running. Restart the laptop, then run the install line again. |
| `404` / `Not Found` | No release has been published yet. Ask whoever set this up. |

## Antivirus

The installer only downloads a zip from GitHub and unzips it into your user folder. If your
antivirus quarantines `pythonw.exe` from `AppData\Local\ScrappyRecords`, mark it as allowed and
run the install line again.

## I deleted something by mistake

Restore yesterday's backup. See [backup-and-restore.md](backup-and-restore.md). Anything entered
since that backup will need to be entered again.

## Where's my data?

`%LOCALAPPDATA%\ScrappyRecords\data\records.db`. Backups are in
`Documents\ScrappyRecords Backups`.
