# Scrappy Records installer and updater for Windows (Windows PowerShell 5.1 or later).
#
# Install or update (paste into PowerShell as one line). The first part switches on TLS 1.2,
# which older Windows 10 needs before it can download anything from GitHub:
#   [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
#
# With options, e.g. a specific version:
#   [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1))) -Version v0.1.0
#
# Options (each can also be set with the environment variable in brackets, which is how tests
# drive the plain `| iex` form, since that can't take arguments):
#   -ZipPath <file>      Install from this zip instead of downloading it. The zip is kept.
#                        [SCRAPPY_INSTALL_ZIP]
#   -Version <tag>       Install this release (e.g. v0.1.0) instead of the latest.
#                        [SCRAPPY_INSTALL_VERSION]
#   -NoLaunch            Don't open the app at the end.              [SCRAPPY_NO_LAUNCH=1]
#   -InstallRoot <dir>   Testing only: install here instead of %LOCALAPPDATA%\ScrappyRecords.
#                        [SCRAPPY_INSTALL_ROOT]
#   -ShortcutDir <dir>   Testing only: put the shortcut here instead of on the Desktop.
#                        [SCRAPPY_SHORTCUT_DIR]
#   [SCRAPPY_TEST_FORCE_FILE_COPY_BACKUP=1]  Testing only: skip the app's own pre-update backup,
#                        so CI can check the file-copy fallback.
#   [SCRAPPY_TEST_FAIL_AFTER_BACKUP=<file>]  Testing only: if <file> exists, delete it and fail
#                        just after the backup, so CI can check what a failed update does.
#
# Started by the app itself (Settings -> Update now, docs/adr/0006-in-app-update.md): the app
# downloads THIS file from the new release's tag and runs it, detached and with no window, as
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File install.ps1 -Version <tag>
# with SCRAPPY_UPDATE_FROM_APP=1 and SCRAPPY_INSTALL_ROOT (the running copy's folder) set, and
# the output going to logs\update.log. Then nothing may ask a question (there is nobody to
# answer), and the app must end up open again: the new version if it worked, else the old one
# (if this closed it). Older apps start newer copies of this file this way, so keep all of that
# working in every release (docs/runbooks/release.md, "Updating from inside the app").
#
# What it does (docs/adr/0003-distribution-and-install.md):
#   1. downloads scrappy-records-windows-x64.zip from the GitHub release to %TEMP%, and unpacks
#      it to app.new next to the current copy;
#   2. stops the app if it is running: first politely (a stop request the server acts on within
#      a second), then by force after 10 seconds;
#   3. saves a backup of the data, with the old version's Python, else the new one's, else by
#      copying the database file together with its journal. If none works, it stops there;
#   4. swaps app.new in for app (the old copy is kept until the swap has worked). The data
#      folder is never touched;
#   5. creates the "Scrappy Records" Desktop shortcut;
#   6. deletes the downloaded zip and opens the app.
#
# Compatibility: this file always comes from `main`, but step 3 runs the *installed* version's
# `python -m app.backup --reason pre-update`; keep that command working in every release.
#
# This file is plain ASCII on purpose: PowerShell 5.1 misreads other characters in files saved
# without a byte-order mark. It never calls `exit`: under `| iex` that would close the window.

param(
    [string]$ZipPath = $env:SCRAPPY_INSTALL_ZIP,
    [string]$Version = $env:SCRAPPY_INSTALL_VERSION,
    [switch]$NoLaunch = ($env:SCRAPPY_NO_LAUNCH -eq '1'),
    [string]$InstallRoot = $env:SCRAPPY_INSTALL_ROOT,
    [string]$ShortcutDir = $env:SCRAPPY_SHORTCUT_DIR
)

function Write-ScrappyStep([string]$Message) {
    Write-Host "  - $Message"
}

function Remove-ScrappyFolder([string]$Path, [switch]$BestEffort) {
    for ($i = 1; $i -le 10; $i++) {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        try {
            [IO.Directory]::Delete($Path, $true)
            return
        } catch {
            if ($i -eq 10) {
                if ($BestEffort) { return }
                throw
            }
            Start-Sleep -Seconds 1
        }
    }
}

function Move-ScrappyFolder([string]$From, [string]$To) {
    # Antivirus scanners can hold files for a moment after unpacking, so retry for a while.
    for ($i = 1; $i -le 15; $i++) {
        try {
            [IO.Directory]::Move($From, $To)
            return
        } catch {
            if ($i -eq 15) { throw }
            Start-Sleep -Seconds 1
        }
    }
}

function Get-ScrappyProcesses([string]$Root) {
    # Only programs started from our own folders: app\, app.new\ and app.old* (left over from an
    # earlier update). Never anyone else's Python.
    $prefixes = @('app\', 'app.new\', 'app.old') | ForEach-Object { Join-Path $Root $_ }
    try {
        # Win32_Process reads 64-bit paths even from a 32-bit PowerShell; Get-Process can't.
        $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            ForEach-Object { New-Object PSObject -Property @{ Id = $_.ProcessId; Path = $_.ExecutablePath } })
    } catch {
        $all = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
            $path = $null
            try { $path = $_.Path } catch { }
            New-Object PSObject -Property @{ Id = $_.Id; Path = $path }
        })
    }
    return @($all | Where-Object {
        $path = $_.Path
        if (-not $path) { return $false }
        foreach ($prefix in $prefixes) {
            if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    })
}

function Stop-ScrappyProcesses([string]$Root, [string]$HomeDir) {
    $procs = @(Get-ScrappyProcesses $Root)
    if ($procs.Count -eq 0) { return 0 }
    # Ask the server to stop, so it isn't killed in the middle of saving (app/lifetime.py).
    $request = Join-Path $HomeDir 'stop-server.request'
    try { [IO.File]::WriteAllText($request, "stop`n") } catch { }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @(Get-ScrappyProcesses $Root).Count -gt 0) {
        Start-Sleep -Milliseconds 500
    }
    # Anything still running (a stuck server, a launcher that is waiting) is stopped by force.
    foreach ($proc in @(Get-ScrappyProcesses $Root)) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
        try { [void](Get-Process -Id $proc.Id -ErrorAction Stop).WaitForExit(15000) } catch { }
    }
    Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue
    return $procs.Count
}

function Invoke-ScrappyProgram([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSeconds = 120) {
    # .NET's Process gives a reliable exit code in PowerShell 5.1 and doesn't turn the program's
    # stderr into PowerShell errors. Never throws: failures come back as ExitCode -1.
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $FilePath
        $psi.Arguments = $Arguments
        $psi.WorkingDirectory = $WorkingDirectory
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $proc = [Diagnostics.Process]::Start($psi)
        $stdout = $proc.StandardOutput.ReadToEndAsync()
        $stderr = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill() } catch { }
            return @{ ExitCode = -1; Output = "no answer after $TimeoutSeconds seconds" }
        }
        $proc.WaitForExit()
        return @{ ExitCode = $proc.ExitCode; Output = ($stdout.Result + $stderr.Result).Trim() }
    } catch {
        return @{ ExitCode = -1; Output = $_.Exception.Message }
    }
}

function Get-ScrappyBackupDir {
    if ($env:SCRAPPY_BACKUP_DIR) { return $env:SCRAPPY_BACKUP_DIR }
    # Same folder the app uses. GetFolderPath follows a Documents folder moved to OneDrive.
    $docs = [Environment]::GetFolderPath('MyDocuments')
    if (-not $docs) { $docs = Join-Path $env:USERPROFILE 'Documents' }
    return (Join-Path $docs 'ScrappyRecords Backups')
}

function Backup-ScrappyData([string[]]$Bundles, [string]$Database) {
    # 1. The app's own backup (SQLite's backup API; it also finishes any interrupted save),
    #    with the installed version's Python, else the new version's.
    foreach ($bundle in $Bundles) {
        $python = Join-Path $bundle 'python\python.exe'
        if (-not (Test-Path -LiteralPath $python)) { continue }
        if ($env:SCRAPPY_TEST_FORCE_FILE_COPY_BACKUP -eq '1') { continue }  # test hook: step 2 only
        $result = Invoke-ScrappyProgram $python '-m app.backup --reason pre-update' $bundle 120
        if ($result.ExitCode -eq 0) {
            Write-ScrappyStep $result.Output
            return
        }
        Write-ScrappyStep "A backup attempt didn't work ($($result.Output))."
    }
    # 2. The app is stopped, so copy the file itself, together with any journal SQLite left
    #    behind: opening the copy then finishes the interrupted save, exactly as the app would.
    $name = 'records-pre-update-{0}.db' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
    $dataDir = Split-Path -Parent $Database
    $lastError = ''
    foreach ($dir in @((Get-ScrappyBackupDir), (Join-Path $dataDir 'backups'))) {
        try {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $target = Join-Path $dir $name
            foreach ($suffix in @('-journal', '-wal', '-shm')) {
                if (Test-Path -LiteralPath ($Database + $suffix)) {
                    Copy-Item -LiteralPath ($Database + $suffix) -Destination ($target + $suffix) -Force
                }
            }
            Copy-Item -LiteralPath $Database -Destination $target -Force
            Write-ScrappyStep "Backup saved (file copy): $target"
            return
        } catch {
            $lastError = $_.Exception.Message
        }
    }
    throw "Couldn't save a backup copy of your data, so nothing was changed. ($lastError)"
}

function New-ScrappyShortcut([string]$LinkPath, [string]$Target, [string]$Arguments, [string]$Directory, [string]$Icon) {
    # WScript.Shell can't handle paths with letters outside the system code page (a Hindi
    # username on English Windows, say), so use the shell's Unicode IShellLinkW, compiled on the
    # fly with the C# compiler every Windows has. WScript.Shell is the fallback, for machines
    # that block compiling (constrained language mode).
    try {
        if (-not ('ScrappyRecordsInstall.ShortcutV1' -as [type])) {
            Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
namespace ScrappyRecordsInstall {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, int flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
        void Resolve(IntPtr hwnd, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }
    public static class ShortcutV1 {
        public static void Create(string link, string target, string args, string dir, string icon, string description) {
            IShellLinkW shellLink = (IShellLinkW)new ShellLink();
            shellLink.SetPath(target);
            shellLink.SetArguments(args);
            shellLink.SetWorkingDirectory(dir);
            shellLink.SetIconLocation(icon, 0);
            shellLink.SetDescription(description);
            ((IPersistFile)shellLink).Save(link, true);
        }
    }
}
'@
        }
        [ScrappyRecordsInstall.ShortcutV1]::Create($LinkPath, $Target, $Arguments, $Directory, $Icon, 'Open Scrappy Records')
    } catch {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($LinkPath)
        $shortcut.TargetPath = $Target
        $shortcut.Arguments = $Arguments
        $shortcut.WorkingDirectory = $Directory
        $shortcut.IconLocation = $Icon + ',0'
        $shortcut.Description = 'Open Scrappy Records'
        $shortcut.Save()
    }
}

function Start-ScrappyApp([string]$AppDir, [switch]$AfterUpdate) {
    # Open the app (the launcher starts the server and the browser). After an update started
    # from the app, the launcher doesn't open a second tab if the old page is still waiting.
    $pythonw = Join-Path $AppDir 'python\pythonw.exe'
    if (-not (Test-Path -LiteralPath $pythonw)) { throw "$pythonw is missing" }
    if ($AfterUpdate) { $env:SCRAPPY_AFTER_UPDATE = '1' }
    try {
        Start-Process -FilePath $pythonw -ArgumentList '-m', 'app.launcher' -WorkingDirectory $AppDir
    } finally {
        if ($AfterUpdate) { Remove-Item Env:SCRAPPY_AFTER_UPDATE -ErrorAction SilentlyContinue }
    }
}

function Get-ScrappyHint([string]$Message) {
    if ($Message -match 'SSL|TLS|secure channel') {
        return 'Windows could not make a secure connection. Run Windows Update, then try again.'
    }
    if ($Message -match 'could not be resolved|Unable to connect|No such host|network') {
        return 'Check that the laptop is connected to the internet, then try again.'
    }
    if ($Message -match '404|Not Found') {
        return 'The download was not found. The release may not be published yet: ask whoever set this up.'
    }
    if ($Message -match 'backup copy') {
        return 'Restart the laptop, then run the install line again. If it keeps happening, ask whoever set this up.'
    }
    if ($Message -match 'denied|being used by another process') {
        return 'Scrappy Records seems to be busy. Restart the laptop, then run the install line again.'
    }
    return 'Something went wrong. Try running the install line again.'
}

function Install-ScrappyRecords {
    param(
        [string]$ZipPath,
        [string]$Version,
        [switch]$NoLaunch,
        [string]$InstallRoot,
        [string]$ShortcutDir
    )
    # Scoped to this function, so the user's PowerShell session is left as it was.
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'  # the progress bar makes PowerShell 5.1 very slow

    $repo = 'srikdhruv/scrappy-business-records'
    $asset = 'scrappy-records-windows-x64.zip'

    Write-Host ''
    Write-Host 'Installing Scrappy Records' -ForegroundColor Cyan

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Scrappy Records needs 64-bit Windows 10 or 11.'
    }
    # Also set by the install line itself; kept here for the other ways of running this file.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $defaultRoot = Join-Path $env:LOCALAPPDATA 'ScrappyRecords'
    if (-not $InstallRoot) { $InstallRoot = $defaultRoot }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $appDir = Join-Path $InstallRoot 'app'
    $newDir = Join-Path $InstallRoot 'app.new'
    $oldDir = Join-Path $InstallRoot 'app.old'
    $homeWasSet = [bool]$env:SCRAPPY_HOME
    if (-not $homeWasSet -and $InstallRoot -ne $defaultRoot) {
        # A test install elsewhere: point the backup and the app at it too.
        $env:SCRAPPY_HOME = $InstallRoot
    }
    $homeDir = if ($env:SCRAPPY_HOME) { $env:SCRAPPY_HOME } else { $InstallRoot }
    $dataDir = if ($env:SCRAPPY_DATA_DIR) { $env:SCRAPPY_DATA_DIR } else { Join-Path $homeDir 'data' }
    $database = Join-Path $dataDir 'records.db'

    # Started by the app's Update now button (see the top of this file).
    $fromApp = ($env:SCRAPPY_UPDATE_FROM_APP -eq '1')
    if ($fromApp) { Write-ScrappyStep "Started from the app, to install $(if ($ZipPath) { $ZipPath } else { $Version })." }

    $downloaded = $false
    $swapped = $false
    $stopped = 0
    $warnings = @()
    try {
        # 1. Get the zip and unpack it next to the current copy.
        if ($ZipPath) {
            $ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
            Write-ScrappyStep "Using $ZipPath"
        } else {
            if ($Version) {
                if ($Version -notmatch '^v') { $Version = "v$Version" }
                $url = "https://github.com/$repo/releases/download/$Version/$asset"
            } else {
                $url = "https://github.com/$repo/releases/latest/download/$asset"
            }
            $ZipPath = Join-Path ([IO.Path]::GetTempPath()) $asset
            Write-ScrappyStep 'Downloading Scrappy Records (about 25 MB, this can take a minute)...'
            $downloaded = $true
            Invoke-WebRequest -Uri $url -OutFile $ZipPath -UseBasicParsing
        }

        Write-ScrappyStep 'Unpacking...'
        New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
        Remove-ScrappyFolder $newDir
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $newDir)
        foreach ($required in @('python\pythonw.exe', 'app\launcher.py', 'VERSION')) {
            if (-not (Test-Path -LiteralPath (Join-Path $newDir $required))) {
                throw "The download looks incomplete ($required is missing). Try again."
            }
        }
        $newVersion = (Get-Content -LiteralPath (Join-Path $newDir 'VERSION') -TotalCount 1).Trim()

        # 2. Stop the running app, if any, so its files can be replaced.
        $stopped = Stop-ScrappyProcesses $InstallRoot $homeDir
        if ($stopped -gt 0) { Write-ScrappyStep 'Closed the running copy of Scrappy Records.' }

        # 3. Back up the data before changing anything.
        if (Test-Path -LiteralPath $database) {
            Write-ScrappyStep 'Saving a backup copy of your data...'
            Backup-ScrappyData @($appDir, $newDir) $database
        }
        if ($env:SCRAPPY_TEST_FAIL_AFTER_BACKUP -and (Test-Path -LiteralPath $env:SCRAPPY_TEST_FAIL_AFTER_BACKUP)) {
            Remove-Item -LiteralPath $env:SCRAPPY_TEST_FAIL_AFTER_BACKUP -Force
            throw 'Test hook: failing after the backup, as asked.'
        }

        # 4. Swap the new copy in.
        Write-ScrappyStep "Installing version $newVersion..."
        # A copy left over from an earlier update that couldn't be deleted (say, an antivirus
        # scan held a file) must not block this one: set it aside under another name.
        Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter 'app.old*' -ErrorAction SilentlyContinue |
            ForEach-Object { Remove-ScrappyFolder $_.FullName -BestEffort }
        if (Test-Path -LiteralPath $oldDir) { $oldDir = "$oldDir-$(Get-Date -Format 'yyyyMMddHHmmss')" }
        if (Test-Path -LiteralPath $appDir) { Move-ScrappyFolder $appDir $oldDir }
        try {
            Move-ScrappyFolder $newDir $appDir
        } catch {
            # Put the previous version back, so the app still works.
            if (-not (Test-Path -LiteralPath $appDir) -and (Test-Path -LiteralPath $oldDir)) {
                Move-ScrappyFolder $oldDir $appDir
            }
            throw
        }
        $swapped = $true
        Remove-ScrappyFolder $oldDir -BestEffort
    } catch {
        if ($downloaded -and -not $swapped) {
            Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
        }
        if ($fromApp -and $stopped -gt 0 -and -not $swapped) {
            # The app closed itself for this update: open the version that is still installed
            # again, so the owner isn't left without it (its page then says the update failed).
            try {
                Write-ScrappyStep 'Opening the version that is still installed again...'
                Start-ScrappyApp $appDir -AfterUpdate
            } catch {
                Write-ScrappyStep "Couldn't open it again ($($_.Exception.Message))."
            }
        }
        if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
        throw
    }

    # From here on the new version is installed: problems are warnings, not failures.
    $pythonw = Join-Path $appDir 'python\pythonw.exe'
    try {
        # 5. Desktop shortcut.
        Write-ScrappyStep 'Creating the Desktop shortcut...'
        if (-not $ShortcutDir) { $ShortcutDir = [Environment]::GetFolderPath('Desktop') }
        if (-not $ShortcutDir) { $ShortcutDir = Join-Path $env:USERPROFILE 'Desktop' }
        New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
        New-ScrappyShortcut (Join-Path $ShortcutDir 'Scrappy Records.lnk') $pythonw '-m app.launcher' `
            $appDir (Join-Path $appDir 'scrappy.ico')
    } catch {
        $warnings += "The Desktop shortcut couldn't be created ($($_.Exception.Message)). Run the install line again to retry, or open the app with: $appDir\Start Scrappy Records.cmd"
    }

    # 6. Tidy up and open the app.
    if ($downloaded) { Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue }
    if (-not $NoLaunch) {
        try {
            Write-ScrappyStep 'Opening Scrappy Records in your browser...'
            Start-ScrappyApp $appDir -AfterUpdate:$fromApp
        } catch {
            $warnings += "The app didn't open by itself ($($_.Exception.Message)). Double-click Scrappy Records on your Desktop."
        }
    }
    if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }

    Write-Host ''
    Write-Host 'Scrappy Records is installed' -ForegroundColor Green
    foreach ($warning in $warnings) { Write-Host "Note: $warning" -ForegroundColor Yellow }
    Write-Host 'From now on, double-click "Scrappy Records" on your Desktop to open it.'
}

try {
    Install-ScrappyRecords -ZipPath $ZipPath -Version $Version -NoLaunch:$NoLaunch `
        -InstallRoot $InstallRoot -ShortcutDir $ShortcutDir
} catch {
    $message = $_.Exception.Message
    Write-Host ''
    Write-Host 'Sorry, Scrappy Records was NOT installed. Your data has not been changed.' -ForegroundColor Red
    Write-Host (Get-ScrappyHint $message) -ForegroundColor Yellow
    Write-Host "Details: $message"
    Write-Host 'Help: https://github.com/srikdhruv/scrappy-business-records/blob/main/docs/runbooks/troubleshooting.md'
    # `throw`, not `exit`: this fails a script or CI step, but leaves the user's window open.
    throw 'Scrappy Records was not installed. See the message above.'
}
