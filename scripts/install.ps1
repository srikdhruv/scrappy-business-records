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
#      against the release's SHA256SUMS (stopping, with nothing changed, if it doesn't match;
#      only v0.1.0, from before checksums, has none), and unpacks it to app.new next to the
#      current copy;
#   2. stops the app if it is running: first politely (a stop request the server acts on within
#      a second), then by force after 10 seconds;
#   3. saves a backup of the data, with the old version's Python, else the new one's, else by
#      copying the database file together with its journal. If none works, it stops there;
#   4. swaps app.new in for app. The data folder is never touched;
#   5. deletes the downloaded zip, opens the new version and waits (up to 3 minutes) for it to
#      answer as the new version (with -NoLaunch: checks it can load). If it doesn't, the old
#      copy (kept as app.old until now) is put back and opened, and this says so;
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
        $health = $client.DownloadString("http://127.0.0.1:$Port/api/health") | ConvertFrom-Json
        if ($health.app -eq 'scrappy-records') { return [string]$health.version }
    } catch { }
    finally { $client.Dispose() }
    return $null
}

function Wait-ScrappyVersion([string]$Version, $Launcher, [string]$Root, [int]$Seconds = 180) {
    # Wait for the new version to answer. Gives up early if the launcher has failed and none of
    # the app's programs is running any more (it won't start); a slow first start may take a
    # few minutes (it backs up and upgrades the records first).
    $port = if ($env:SCRAPPY_PORT) { $env:SCRAPPY_PORT } else { '8765' }
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ScrappyRunningVersion $port) -eq $Version) { return $true }
        if ($Launcher -and $Launcher.HasExited -and $Launcher.ExitCode -ne 0 -and
            @(Get-ScrappyProcesses $Root).Count -eq 0) {
            Start-Sleep -Seconds 1
            return ((Get-ScrappyRunningVersion $port) -eq $Version)
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

function Assert-ScrappyChecksum([string]$File, [string]$Name, [string]$Sums) {
    # $File must have the SHA-256 that $Sums (sha256sum's format) gives for $Name.
    $expected = $null
    foreach ($line in ($Sums -split "`r?`n")) {
        if ($line -match '^([0-9a-fA-F]{64}) [ *]?(\S.*?)\s*$' -and $Matches[2] -eq $Name) {
            $expected = $Matches[1].ToLowerInvariant()
        }
    }
    if (-not $expected) { throw "The checksum list (SHA256SUMS) doesn't include $Name, so the download can't be checked. Nothing was changed." }
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "The download doesn't match its checksum (SHA256SUMS): it may be damaged, or not the real one. Nothing was changed."
    }
    Write-ScrappyStep 'The download matches its checksum.'
}

function Get-ScrappyZipVersion([string]$ZipPath) {
    # VERSION from inside the zip, without unpacking it.
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entry = $zip.GetEntry('VERSION')
        if (-not $entry) { return $null }
        $reader = New-Object IO.StreamReader($entry.Open())
        try { return $reader.ReadLine().Trim() } finally { $reader.Dispose() }
    } finally {
        $zip.Dispose()
    }
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
            } else {
                # Only releases from before checksums (v0.1.0) have no SHA256SUMS.
                $zipVersion = Get-ScrappyZipVersion $ZipPath
                $parts = @(([string]$zipVersion) -split '[.+-]')
                $isOld = $parts.Count -ge 3 -and $parts[0] -match '^[0-9]+$' -and $parts[1] -match '^[0-9]+$' -and
                    $parts[2] -match '^[0-9]+$' -and [int]$parts[0] -eq 0 -and
                    ([int]$parts[1] -lt 1 -or ([int]$parts[1] -eq 1 -and [int]$parts[2] -eq 0))
                if (-not $isOld) {
                    throw "This release has no checksum list (SHA256SUMS), so the download can't be checked. Nothing was changed."
                }
                Write-ScrappyStep "Version $zipVersion was published before checksums; installing it unchecked."
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

        # 3. Back up the data before changing anything.
        if (Test-Path -LiteralPath $database) {
            Write-ScrappyStep 'Saving a backup copy of your data...'
            Backup-ScrappyData @($appDir, $newDir) $database
        }
        if ($env:SCRAPPY_TEST_FAIL_AFTER_BACKUP -and (Test-Path -LiteralPath $env:SCRAPPY_TEST_FAIL_AFTER_BACKUP)) {
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

    # 5. Does the new version start? Open it and wait (up to 3 minutes) for it to answer as
    #    the new version; with -NoLaunch, check its Python can at least load the app. If not,
    #    put the old version back and open that instead.
    $started = $false
    $launcher = $null
    if (-not $NoLaunch) {
        try {
            Write-ScrappyStep 'Opening Scrappy Records in your browser...'
            $launcher = Start-ScrappyApp $appDir -AfterUpdate:$fromApp -NoDialog
            $started = Wait-ScrappyVersion $newVersion $launcher $InstallRoot 180
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
        Write-ScrappyStep "Version $newVersion didn't start: putting version $oldVersion back..."
        [void](Stop-ScrappyProcesses $InstallRoot $homeDir)
        $failedDir = Join-Path $InstallRoot "app.failed-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Move-ScrappyFolder $appDir $failedDir
        Move-ScrappyFolder $oldDir $appDir
        Remove-ScrappyFolder $failedDir -BestEffort
        if (-not $fromApp) { Write-ScrappyLog $homeDir "Version $newVersion didn't start, so version $oldVersion was put back." }
        if (-not $NoLaunch -or $fromApp) {
            try { [void](Start-ScrappyApp $appDir -AfterUpdate:$fromApp) } catch { }
        }
        if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
        throw "The new version ($newVersion) didn't start, so the previous version ($oldVersion) was put back and opened again."
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
