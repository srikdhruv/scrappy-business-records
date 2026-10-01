# Release check on a real Windows laptop

The release workflow already installs every release on a fresh Windows machine in the cloud
(see [release.md](release.md)). That machine is clean but artificial. This 10-minute check
covers what only a **real laptop** has: a real Desktop and Documents folder (often synced to
OneDrive), real antivirus, a real double-click on the shortcut, and a real restart.

**Do it** before the owner's first install, and after any release that changes the installer,
the launcher or backups. For other releases it's optional.

**You need:** a Windows 10 or 11 laptop that isn't the owner's (or is, before she has real data
in the app), internet access, and about 10 minutes. The Windows x64 download also runs on
Arm-based Windows.

> Use only made-up names and amounts while testing (e.g. "Test Student", ₹1,000). Step 10 removes
> them afterwards.

## Checklist

Tick each box. If anything doesn't match, stop and note what you saw in the results table at
the bottom (a photo of the screen helps).

### Install

1. [ ] Open **Windows PowerShell** (Windows key → type `PowerShell` → Enter), paste the install
   line from [install-windows.md](install-windows.md#steps), and press Enter.
2. [ ] It ends with **"Scrappy Records is installed"**, shows **"Installing version X.Y.Z"**
   with the version you just released, and the app opens in the browser by itself.
3. [ ] A **Scrappy Records** shortcut with the orange ₹ icon is on the Desktop. If the Desktop is
   synced to OneDrive, check the Desktop you actually see.

### Use it

4. [ ] Add two students (**Students → + New student**), e.g. "Test Student A" (fee ₹1,000) and
   "Test Student B" (fee ₹1,500).
5. [ ] Log a payment for Test Student A for this month (**+ Log payment**). The dashboard now shows
   only Test Student B under *Yet to pay*, and *Collected* is ₹1,000.

### Data survives

6. [ ] Close the browser completely, then double-click the Desktop shortcut. Within a few
   seconds the app opens, with no black window, and both students and the payment are still
   there.
7. [ ] **Restart the laptop.** Double-click the shortcut again. Everything is still there.
8. [ ] In File Explorer, open `Documents\ScrappyRecords Backups`. There is a file named
   `records-<today's date>.db`. If it's instead in `%LOCALAPPDATA%\ScrappyRecords\data\backups`,
   note that: Documents was blocked, for example by OneDrive or "Controlled folder access".

### Update

9. [ ] Paste the install line into PowerShell again, while the app is still open. It says
   **"Scrappy Records is installed"** again. The app reopens with the same data, and the backups
   folder now also has a `records-pre-update-….db` file.
10. [ ] **Update now** (from v0.2.0, when a newer release than the installed one exists: install
    the previous release with `-Version`, then open the app). Within a minute the page says "A
    new version (…) is ready" (or use **⚙ Settings → About → Check for updates**). Click **Update
    now** → **Update now**. No window flashes up, the page says "Updating…", then reloads on
    the new version with the same data and "Updated to version …". Only one browser tab is
    open, and there's another `records-pre-update-….db`.

### Clean up (only if the owner will use this laptop)

11. [ ] Restart the laptop, so the app isn't running. Then delete the folder
    `%LOCALAPPDATA%\ScrappyRecords\data` (paste the path into File Explorer's address bar). Also
    delete the test backups in `Documents\ScrappyRecords Backups`. The next time the app opens,
    it starts empty.

## If something fails

- The install line shows red text: see
  [troubleshooting](troubleshooting.md#the-install-line-shows-an-error).
- The app doesn't open, or shows a message box: send
  `%LOCALAPPDATA%\ScrappyRecords\logs\server.log` along with the photo.
- Anything else: note the step number and what you saw.

Then don't install the release on the owner's laptop yet. Open a GitHub issue (with no personal
details) or tell the developer. Fix it on `main`, release a patch version, and repeat this
check.

## Results

Add a row for each check. Commit it via a PR, or put it in the release notes.

| Date | Version | Laptop (Windows version, OneDrive on/off) | Tester | Result | Notes |
|---|---|---|---|---|---|
| | | | | | |
