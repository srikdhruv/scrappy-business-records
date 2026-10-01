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
#   Testing only, and only with SCRAPPY_TEST_MODE=1 (ignored otherwise):
#   [SCRAPPY_TEST_FORCE_FILE_COPY_BACKUP=1]  skip the app's own pre-update backup, so CI can
#                        check the file-copy fallback.
#   [SCRAPPY_TEST_FAIL_AFTER_BACKUP=<file>]  if <file> exists, delete it and fail just after the
#                        backup, so CI can check what a failed update does.
#   [SCRAPPY_TEST_MODE=1 + SCRAPPY_INSTALL_DOWNLOAD_URL=<url>/]  Testing only: download the
#                        release's files (zip, SHA256SUMS) from <url> instead of GitHub.
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
#   1. downloads scrappy-records-windows-x64.zip from the GitHub release to %TEMP%, checks it
#      against the release's SHA256SUMS (stopping, with nothing changed, if it doesn't match or
#      is missing; only -Version v0.1.0, from before checksums, is installed without), and
#      unpacks it to app.new next to the current copy;
#   2. stops the app if it is running: first politely (a stop request the server acts on within
#      a second), then by force after 10 seconds;
#   3. saves a backup of the data, with the old version's Python, else the new one's, else by
#      copying the database file together with its journal. If none works, it stops there;
#   4. swaps app.new in for app. The data folder is never touched;
#   5. deletes the downloaded zip, opens the new version and waits for it to answer as the new
#      version (up to 10 minutes while it is still starting; with -NoLaunch: checks it can
#      load). If it never does, the old copy (kept as app.old until now) is put back and opened,
#      with the pre-update backup put back too if the failed start changed the records;
#   6. creates the "Scrappy Records" Desktop shortcut.
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

function Get-ScrappyLongPath([string]$Path) {
    # A folder can be spelled two ways on Windows: C:\Users\RUNNER~1\... (an 8.3 short name)
    # and C:\Users\runneradmin\.... The same program started one way can be reported the other,
    # so compare long names. Returns the path unchanged if it has no short part or can't be read.
    if (-not $Path -or $Path.IndexOf('~') -lt 0) { return $Path }
    try {
        if (-not ('ScrappyRecordsInstall.LongPathV1' -as [type])) {
            Add-Type -Language CSharp -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
namespace ScrappyRecordsInstall {
    public static class LongPathV1 {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);
        public static string Get(string path) {
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
            return (length > 0 && length < buffer.Capacity) ? buffer.ToString() : path;
        }
    }
}
'@
        }
        return [ScrappyRecordsInstall.LongPathV1]::Get($Path)
    } catch {
        return $Path
    }
}

function Get-ScrappyProcesses([string]$Root) {
    # Only programs started from our own folders: app\, app.new\ and app.old* (left over from an
    # earlier update). Never anyone else's Python. The folder and each program's path are also
    # compared by their long names (see Get-ScrappyLongPath).
    $roots = @($Root, (Get-ScrappyLongPath $Root)) | Select-Object -Unique
    $prefixes = foreach ($r in $roots) { @('app\', 'app.new\', 'app.old') | ForEach-Object { Join-Path $r $_ } }
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
        foreach ($candidate in @($path, (Get-ScrappyLongPath $path))) {
            foreach ($prefix in $prefixes) {
                if ($candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
            }
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
        # UTF-8 both ways, so paths with any letters (the backup's) come back intact.
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
        $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
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
    # Returns the exact path of the backup it wrote (the restore after a failed start uses it).
    # 1. The app's own backup (SQLite's backup API; it also finishes any interrupted save),
    #    with the installed version's Python, else the new version's.
    foreach ($bundle in $Bundles) {
        $python = Join-Path $bundle 'python\python.exe'
        if (-not (Test-Path -LiteralPath $python)) { continue }
        if ($env:SCRAPPY_TEST_MODE -eq '1' -and $env:SCRAPPY_TEST_FORCE_FILE_COPY_BACKUP -eq '1') { continue }  # test hook: step 2 only
        $result = Invoke-ScrappyProgram $python '-m app.backup --reason pre-update' $bundle 120
        if ($result.ExitCode -eq 0) {
            Write-ScrappyStep $result.Output
            if ($result.Output -match '(?m)^Backup saved: (.+?)\s*$' -and (Test-Path -LiteralPath $Matches[1])) {
                return $Matches[1]
            }
            return $null
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
            return $target
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

function Start-ScrappyApp([string]$AppDir, [switch]$AfterUpdate, [switch]$NoDialog) {
    # Open the app (the launcher starts the server and the browser), and return the launcher's
    # process. After an update started from the app, the launcher doesn't open a second tab if
    # the old page is still waiting. -NoDialog: while this script checks the new version
    # starts, the launcher must not stop to show a message box.
    $pythonw = Join-Path $AppDir 'python\pythonw.exe'
    if (-not (Test-Path -LiteralPath $pythonw)) { throw "$pythonw is missing" }
    $saved = @{ SCRAPPY_AFTER_UPDATE = $env:SCRAPPY_AFTER_UPDATE; SCRAPPY_NO_DIALOG = $env:SCRAPPY_NO_DIALOG }
    if ($AfterUpdate) { $env:SCRAPPY_AFTER_UPDATE = '1' }
    if ($NoDialog) { $env:SCRAPPY_NO_DIALOG = '1' }
    try {
        $process = Start-Process -FilePath $pythonw -ArgumentList '-m', 'app.launcher' -WorkingDirectory $AppDir -PassThru
        [void]$process.Handle  # keep a handle, or PowerShell 5.1 can't read ExitCode later
        return $process
    } finally {
        foreach ($name in $saved.Keys) {
            if ($null -eq $saved[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$name" $saved[$name] }
        }
    }
}

function Get-ScrappyRunningVersion([string]$Port) {
    # The version /api/health answers with, or $null if Scrappy Records isn't answering.
    $client = New-Object Net.WebClient
    $client.Proxy = $null
    try {
        # A regular expression, not ConvertFrom-Json: nothing to load from a module.
        $body = $client.DownloadString("http://127.0.0.1:$Port/api/health")
        if ($body -match '"app"\s*:\s*"scrappy-records"' -and $body -match '"version"\s*:\s*"([^"]+)"') {
            return $Matches[1]
        }
    } catch { }
    finally { $client.Dispose() }
    return $null
}

function Wait-ScrappyVersion([string]$Version, $Launcher, [string]$Root, [int]$Seconds = 600) {
    # Wait for the new version to answer. A first start can be slow (an antivirus scanning the
    # new files, a backup and an upgrade of the records first), so keep waiting, up to 10
    # minutes, while any of its programs is still running; give up early only once the launcher
    # has failed and none is left (it crashed). Returns $true as soon as it answers once.
    $port = if ($env:SCRAPPY_PORT) { $env:SCRAPPY_PORT } else { '8765' }
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ScrappyRunningVersion $port) -eq $Version) { return $true }
        if ($Launcher -and $Launcher.HasExited -and @(Get-ScrappyProcesses $Root).Count -eq 0) {
            Start-Sleep -Seconds 2
            if ((Get-ScrappyRunningVersion $port) -eq $Version) { return $true }
            if (@(Get-ScrappyProcesses $Root).Count -eq 0) { return $false }
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-ScrappySums([string]$Url) {
    # The release's SHA256SUMS, or $null if it has none (404: a release from before checksums).
    # (GitHub serves it as a binary file: download it, then read it as text.)
    $file = [IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
        return [IO.File]::ReadAllText($file)
    } catch {
        $response = $_.Exception.Response
        if ($response -and [int]$response.StatusCode -eq 404) { return $null }
        throw
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

function Get-ScrappySha256([string]$File) {
    # .NET's SHA256 rather than Get-FileHash: no module to load (a PSModulePath inherited from
    # PowerShell 7 can stop Windows PowerShell 5.1 loading it).
    $stream = [IO.File]::Open($File, 'Open', 'Read', 'ReadWrite')
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-ScrappyRecordsState([string]$Database) {
    # A fingerprint of the records file and any journal next to it: if it changes, something
    # wrote to the records.
    $parts = @()
    foreach ($suffix in @('', '-journal', '-wal', '-shm')) {
        $file = $Database + $suffix
        if (Test-Path -LiteralPath $file) { $parts += "$suffix=$(Get-ScrappySha256 $file)" }
    }
    return ($parts -join '|')
}

function Find-ScrappyPreUpdateBackup([string]$Database, [datetime]$Since) {
    # The pre-update backup this run just took (in the backups folder, or data\backups).
    $dirs = @((Get-ScrappyBackupDir), (Join-Path (Split-Path -Parent $Database) 'backups'))
    $found = @(foreach ($dir in $dirs) {
        if (Test-Path -LiteralPath $dir) {
            Get-ChildItem -LiteralPath $dir -Filter 'records-pre-update-*.db' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -ge $Since }
        }
    })
    if ($found.Count -eq 0) { return $null }
    return ($found | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
}

function Restore-ScrappyRecords([string]$Database, [string]$Backup, [string]$Python, [scriptblock]$Log) {
    # Put the pre-update backup back as the records (ADR 0004's one exception: the new version
    # never started, so nothing can have been entered since the backup). The records as the new
    # version left them are kept, never deleted, next to the backup. If anything goes wrong,
    # everything is put back as it was before this step, and this throws.
    if (-not $Backup -or -not (Test-Path -LiteralPath $Backup)) {
        throw "the backup taken before the update wasn't found"
    }
    $aside = Join-Path (Split-Path -Parent $Backup) ('records-failed-update-{0}.db' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $moved = @()
    $copied = @()
    $originals = @(@('', '-journal', '-wal', '-shm') | Where-Object { Test-Path -LiteralPath ($Database + $_) })
    try {
        foreach ($suffix in @('', '-journal', '-wal', '-shm')) {
            if (Test-Path -LiteralPath ($Database + $suffix)) {
                Move-Item -LiteralPath ($Database + $suffix) -Destination ($aside + $suffix)
                $moved += $suffix
            }
        }
        & $Log "Kept the records as the new version left them: $aside"
        foreach ($suffix in @('-journal', '-wal', '-shm')) {
            if (Test-Path -LiteralPath ($Backup + $suffix)) {
                Copy-Item -LiteralPath ($Backup + $suffix) -Destination ($Database + $suffix)
                $copied += $suffix
            }
        }
        Copy-Item -LiteralPath $Backup -Destination ($Database + '.restoring')
        Move-Item -LiteralPath ($Database + '.restoring') -Destination $Database
        $copied += ''
        & $Log "Copied the backup from before the update back in: $Backup"
        $code = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute('PRAGMA integrity_check').fetchone()[0]; t=c.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]; print(r); sys.exit(0 if r == 'ok' and t else 1)"
        $check = Invoke-ScrappyProgram $Python ('-c "' + $code + '" "' + $Database + '"') (Split-Path -Parent $Python) 120
        if ($check.ExitCode -ne 0) { throw "the restored copy didn't pass its check ($($check.Output))" }
        & $Log 'Checked the restored records: they open and are sound.'
    } catch {
        $why = $_.Exception.Message
        # Undo this step: the copies of the backup go (the backup itself stays), the records as
        # the new version left them come back. If even that fails, leave everything where it is.
        # Anything at the records' names now that isn't an original still in place (a copy of
        # the backup, or a -wal/-shm the check left behind) goes first, so nothing blocks them.
        foreach ($suffix in @('', '-journal', '-wal', '-shm')) {
            if (($moved -contains $suffix) -or -not ($originals -contains $suffix)) {
                Remove-Item -LiteralPath ($Database + $suffix) -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath ($Database + '.restoring') -Force -ErrorAction SilentlyContinue
        foreach ($suffix in $moved) {
            try {
                if (-not (Test-Path -LiteralPath ($Database + $suffix))) {
                    Move-Item -LiteralPath ($aside + $suffix) -Destination ($Database + $suffix)
                }
            } catch { }
        }
        & $Log "Couldn't put the records back by themselves: $why"
        throw $why
    }
}

function Assert-ScrappyChecksum([string]$File, [string]$Name, [string]$Sums) {
    # $File must have the SHA-256 that $Sums (sha256sum's format) gives for $Name.
    $expected = $null
    foreach ($line in ($Sums -split "`r?`n")) {
        if ($line -match '^([0-9a-fA-F]{64}) [ *]?(\S.*?)\s*$' -and $Matches[2] -eq $Name) {
            $expected = $Matches[1].ToLowerInvariant()
        }
    }
    if (-not $expected) { throw "The checksum list (SHA256SUMS) doesn't include $Name, so the download can't be checked. Nothing was changed." }
    $actual = Get-ScrappySha256 $File
    if ($actual -ne $expected) {
        throw "The download doesn't match its checksum (SHA256SUMS): it may be damaged, or not the real one. Nothing was changed."
    }
    Write-ScrappyStep 'The download matches its checksum.'
}

function Write-ScrappyLog([string]$HomeDir, [string]$Message) {
    # One line in logs\update.log (an update started from the app writes all its output there).
    try {
        $dir = Join-Path $HomeDir 'logs'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $line = '{0} {1}{2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message, [Environment]::NewLine
        [IO.File]::AppendAllText((Join-Path $dir 'update.log'), $line)
    } catch { }
}

function Get-ScrappyHint([string]$Message) {
    if ($Message -match "records couldn't be put back") {
        return 'Nothing is lost: the copy from before the update is in the backups folder. Ask whoever set this up to restore it (docs/runbooks/backup-and-restore.md).'
    }
    if ($Message -match "previous version couldn't be put back") {
        return 'Your records are safe. Restart the laptop, then run the install line again.'
    }
    if ($Message -match "didn't start") {
        return 'Your previous version was put back and opened again, with your records. Tell whoever set this up.'
    }
    if ($Message -match 'checksum|SHA256SUMS') {
        return 'The download did not check out. Try again later; if it keeps happening, ask whoever set this up.'
    }
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
    Add-Type -AssemblyName System.IO.Compression.FileSystem

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
    $hadOld = $false
    $oldVersion = ''
    $preUpdateBackup = $null
    $recordsBefore = $null
    $warnings = @()
    try {
        # 1. Get the zip, check it against the release's SHA256SUMS, and unpack it next to the
        #    current copy.
        if ($ZipPath) {
            $ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
            Write-ScrappyStep "Using $ZipPath"
            # A local zip (tests, or whoever set this up) is checked if a SHA256SUMS lies next to it.
            $localSums = Join-Path (Split-Path -Parent $ZipPath) 'SHA256SUMS'
            if (Test-Path -LiteralPath $localSums) {
                Assert-ScrappyChecksum $ZipPath (Split-Path -Leaf $ZipPath) ([IO.File]::ReadAllText($localSums))
            }
        } else {
            if ($Version -and $Version -notmatch '^v') { $Version = "v$Version" }
            if ($env:SCRAPPY_TEST_MODE -eq '1' -and $env:SCRAPPY_INSTALL_DOWNLOAD_URL) {
                $base = $env:SCRAPPY_INSTALL_DOWNLOAD_URL  # testing only: a local release server
                if (-not $base.EndsWith('/')) { $base += '/' }
            } elseif ($Version) {
                $base = "https://github.com/$repo/releases/download/$Version/"
            } else {
                $base = "https://github.com/$repo/releases/latest/download/"
            }
            $ZipPath = Join-Path ([IO.Path]::GetTempPath()) $asset
            Write-ScrappyStep 'Downloading Scrappy Records (about 25 MB, this can take a minute)...'
            $downloaded = $true
            Invoke-WebRequest -Uri ($base + $asset) -OutFile $ZipPath -UseBasicParsing
            $sums = Get-ScrappySums ($base + 'SHA256SUMS')
            if ($null -ne $sums) {
                Assert-ScrappyChecksum $ZipPath $asset $sums
            } elseif ($Version -eq 'v0.1.0') {
                # The one release from before checksums, and only when asked for by name.
                Write-ScrappyStep 'Version v0.1.0 was published before checksums; installing it unchecked, as asked.'
            } else {
                throw "This release has no checksum list (SHA256SUMS), so the download can't be checked. Nothing was changed."
            }
        }

        Write-ScrappyStep 'Unpacking...'
        New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
        Remove-ScrappyFolder $newDir
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

        # 3. Back up the data before changing anything, and remember the records as they are
        #    now: if the new version won't start, this tells whether it changed them.
        if (Test-Path -LiteralPath $database) {
            Write-ScrappyStep 'Saving a backup copy of your data...'
            $backupStart = (Get-Date).AddSeconds(-2)
            $preUpdateBackup = Backup-ScrappyData @($appDir, $newDir) $database
            if (-not $preUpdateBackup) {
                # An older version's backup that didn't say where (or not readably): the newest
                # one written since this run started.
                $preUpdateBackup = Find-ScrappyPreUpdateBackup $database $backupStart
            }
            $recordsBefore = Get-ScrappyRecordsState $database
        }
        if ($env:SCRAPPY_TEST_MODE -eq '1' -and $env:SCRAPPY_TEST_FAIL_AFTER_BACKUP -and
            (Test-Path -LiteralPath $env:SCRAPPY_TEST_FAIL_AFTER_BACKUP)) {
            Remove-Item -LiteralPath $env:SCRAPPY_TEST_FAIL_AFTER_BACKUP -Force
            throw 'Test hook: failing after the backup, as asked.'
        }

        # 4. Swap the new copy in. The old one is kept (app.old) until the new one has started.
        Write-ScrappyStep "Installing version $newVersion..."
        # A copy left over from an earlier update that couldn't be deleted (say, an antivirus
        # scan held a file) must not block this one: set it aside under another name.
        Get-ChildItem -LiteralPath $InstallRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'app.old*' -or $_.Name -like 'app.failed*' } |
            ForEach-Object { Remove-ScrappyFolder $_.FullName -BestEffort }
        if (Test-Path -LiteralPath $oldDir) { $oldDir = "$oldDir-$(Get-Date -Format 'yyyyMMddHHmmss')" }
        if (Test-Path -LiteralPath $appDir) {
            $versionFile = Join-Path $appDir 'VERSION'
            if (Test-Path -LiteralPath $versionFile) { $oldVersion = (Get-Content -LiteralPath $versionFile -TotalCount 1).Trim() }
            Move-ScrappyFolder $appDir $oldDir
            $hadOld = $true
        }
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
    } catch {
        if ($downloaded -and -not $swapped) {
            Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
        }
        if ($fromApp -and $stopped -gt 0 -and -not $swapped) {
            # The app closed itself for this update: open the version that is still installed
            # again, so the owner isn't left without it (its page then says the update failed).
            try {
                Write-ScrappyStep 'Opening the version that is still installed again...'
                [void](Start-ScrappyApp $appDir -AfterUpdate)
            } catch {
                Write-ScrappyStep "Couldn't open it again ($($_.Exception.Message))."
            }
        }
        if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
        throw
    }

    $pythonw = Join-Path $appDir 'python\pythonw.exe'
    if ($downloaded) { Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue }

    # 5. Does the new version start? Open it and wait for it to answer as the new version (up
    #    to 10 minutes while it is still starting); with -NoLaunch, check its Python can at least
    #    load the app. Once it has answered, it stays (it may have been used). If it never does,
    #    put the old version back and open that instead.
    $started = $false
    $launcher = $null
    if (-not $NoLaunch) {
        try {
            Write-ScrappyStep 'Opening Scrappy Records in your browser...'
            $launcher = Start-ScrappyApp $appDir -AfterUpdate:$fromApp -NoDialog
            $started = Wait-ScrappyVersion $newVersion $launcher $InstallRoot 600
        } catch {
            Write-ScrappyStep "The new version didn't open ($($_.Exception.Message))."
        }
    } else {
        $check = Invoke-ScrappyProgram (Join-Path $appDir 'python\python.exe') '-c "import app.main"' $appDir 120
        $started = ($check.ExitCode -eq 0)
        if (-not $started) { Write-ScrappyStep "The new version can't load ($($check.Output))." }
    }
    if (-not $started) {
        if (-not $hadOld) {
            if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
            throw "The new version ($newVersion) didn't start. Run the install line again, or ask whoever set this up."
        }
        # Every step goes to logs\update.log (started from the app, all output already does).
        $log = { param($Message) Write-ScrappyStep $Message; if (-not $fromApp) { Write-ScrappyLog $homeDir $Message } }
        & $log "Version $newVersion didn't start: putting version $oldVersion back..."
        [void](Stop-ScrappyProcesses $InstallRoot $homeDir)
        $failedDir = Join-Path $InstallRoot "app.failed-$(Get-Date -Format 'yyyyMMddHHmmss')"
        $openIt = (-not $NoLaunch -or $fromApp)
        try {
            Move-ScrappyFolder $appDir $failedDir
        } catch {
            $why = $_.Exception.Message
            & $log "Couldn't move version $newVersion aside ($why); it stays, and version $oldVersion is kept in $oldDir."
            if ($openIt) { try { [void](Start-ScrappyApp $appDir -AfterUpdate:$fromApp) } catch { } }
            if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
            throw "The new version ($newVersion) didn't start, and the previous version couldn't be put back ($why)."
        }
        try {
            Move-ScrappyFolder $oldDir $appDir
        } catch {
            $why = $_.Exception.Message
            # Never leave no app at all: the new version goes back where it was.
            try { Move-ScrappyFolder $failedDir $appDir } catch { }
            & $log "Couldn't put version $oldVersion back ($why); version $newVersion stays, and version $oldVersion is kept in $oldDir."
            if ($openIt) { try { [void](Start-ScrappyApp $appDir -AfterUpdate:$fromApp) } catch { } }
            if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
            throw "The new version ($newVersion) didn't start, and the previous version couldn't be put back ($why)."
        }
        Remove-ScrappyFolder $failedDir -BestEffort
        & $log "Version $newVersion didn't start, so version $oldVersion was put back."
        # Did the failed start change the records (an upgrade that ran, then a crash)? Then the
        # old version may not be able to open them: put back the backup taken just before
        # (ADR 0004). If that fails, don't open the old version on records it may not read.
        $records = ''
        if ($recordsBefore -and (Get-ScrappyRecordsState $database) -ne $recordsBefore) {
            & $log 'The new version changed the records before it stopped: putting back the backup from before the update...'
            try {
                Restore-ScrappyRecords $database $preUpdateBackup (Join-Path $appDir 'python\python.exe') $log
                & $log 'Your records were put back as they were before the update.'
                $records = ', and your records were put back as they were before the update'
            } catch {
                $openIt = $false
                $records = ", but your records couldn't be put back as they were before the update by themselves ($($_.Exception.Message)). Nothing is lost: the backup from before the update is $preUpdateBackup"
            }
        } elseif ($recordsBefore) {
            & $log 'Your records were not changed.'
        }
        if ($openIt) {
            try { [void](Start-ScrappyApp $appDir -AfterUpdate:$fromApp) } catch { }
        }
        if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
        $opened = if ($openIt) { ' and opened again' } else { '' }
        throw "The new version ($newVersion) didn't start, so the previous version ($oldVersion) was put back$opened$records."
    }
    Remove-ScrappyFolder $oldDir -BestEffort

    # From here on the new version is installed and running: problems are warnings.
    try {
        # 6. Desktop shortcut.
        Write-ScrappyStep 'Creating the Desktop shortcut...'
        if (-not $ShortcutDir) { $ShortcutDir = [Environment]::GetFolderPath('Desktop') }
        if (-not $ShortcutDir) { $ShortcutDir = Join-Path $env:USERPROFILE 'Desktop' }
        New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
        New-ScrappyShortcut (Join-Path $ShortcutDir 'Scrappy Records.lnk') $pythonw '-m app.launcher' `
            $appDir (Join-Path $appDir 'scrappy.ico')
    } catch {
        $warnings += "The Desktop shortcut couldn't be created ($($_.Exception.Message)). Run the install line again to retry, or open the app with: $appDir\Start Scrappy Records.cmd"
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
