# Scrappy Records installer and updater for Windows (Windows PowerShell 5.1 or later).
#
# Install or update (paste into PowerShell):
#   irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
#
# With options, e.g. a specific version:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1))) -Version v0.1.0
#
# Options (each can also be set with the environment variable in brackets, which is how tests
# drive the plain `| iex` form, since that can't take arguments):
#   -ZipPath <file>      Install from this zip instead of downloading it. The zip is kept.
#                        [SCRAPPY_INSTALL_ZIP]
#   -Version <tag>       Install this release (e.g. v0.1.0) instead of the latest.
#   -NoLaunch            Don't open the app at the end.              [SCRAPPY_NO_LAUNCH=1]
#   -InstallRoot <dir>   Testing only: install here instead of %LOCALAPPDATA%\ScrappyRecords.
#                        [SCRAPPY_INSTALL_ROOT]
#   -ShortcutDir <dir>   Testing only: put the shortcut here instead of on the Desktop.
#                        [SCRAPPY_SHORTCUT_DIR]
#
# What it does (docs/adr/0003-distribution-and-install.md):
#   1. downloads scrappy-records-windows-x64.zip from the GitHub release to %TEMP%;
#   2. stops the app if it is running;
#   3. saves a backup of the data (with the old version's Python) if there is any;
#   4. unpacks the zip to app.new, then swaps it in for app (the old copy is kept until the swap
#      has worked). The data folder is never touched;
#   5. creates the "Scrappy Records" Desktop shortcut;
#   6. deletes the downloaded zip and opens the app.
#
# This file is plain ASCII on purpose: PowerShell 5.1 misreads other characters in files saved
# without a byte-order mark. It never calls `exit`: under `| iex` that would close the window.

param(
    [string]$ZipPath = $env:SCRAPPY_INSTALL_ZIP,
    [string]$Version = '',
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

function Stop-ScrappyProcesses([string]$Root) {
    # Only processes started from our own folders: never someone else's Python.
    $prefixes = @('app', 'app.new', 'app.old') | ForEach-Object { (Join-Path $Root $_) + '\' }
    $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $path = $null
        try { $path = $_.Path } catch { }
        if (-not $path) { return $false }
        foreach ($prefix in $prefixes) {
            if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    })
    foreach ($proc in $procs) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
    }
    foreach ($proc in $procs) {
        try { [void]$proc.WaitForExit(15000) } catch { }
    }
    return $procs.Count
}

function Invoke-ScrappyProgram([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory) {
    # .NET's Process gives a reliable exit code in PowerShell 5.1 and doesn't turn the program's
    # stderr into PowerShell errors.
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
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    return @{ ExitCode = $proc.ExitCode; Output = ($stdout.Result + $stderr).Trim() }
}

function Get-ScrappyBackupDir {
    if ($env:SCRAPPY_BACKUP_DIR) { return $env:SCRAPPY_BACKUP_DIR }
    # Same folder the app uses. GetFolderPath follows a Documents folder moved to OneDrive.
    $docs = [Environment]::GetFolderPath('MyDocuments')
    if (-not $docs) { $docs = Join-Path $env:USERPROFILE 'Documents' }
    return (Join-Path $docs 'ScrappyRecords Backups')
}

function Get-ScrappyDatabase([string]$Root) {
    if ($env:SCRAPPY_DATA_DIR) { return (Join-Path $env:SCRAPPY_DATA_DIR 'records.db') }
    if ($env:SCRAPPY_HOME) { return (Join-Path $env:SCRAPPY_HOME 'data\records.db') }
    return (Join-Path $Root 'data\records.db')
}

function Backup-ScrappyData([string]$AppDir, [string]$Database) {
    $python = Join-Path $AppDir 'python\python.exe'
    if (Test-Path -LiteralPath $python) {
        $result = Invoke-ScrappyProgram $python '-m app.backup --reason pre-update' $AppDir
        if ($result.ExitCode -eq 0) {
            Write-ScrappyStep $result.Output
            return
        }
        Write-ScrappyStep "The usual backup didn't work ($($result.Output)); copying the file instead."
    }
    # The app is stopped, so a plain copy of the file is complete and consistent.
    $dir = Get-ScrappyBackupDir
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $target = Join-Path $dir ('records-pre-update-{0}.db' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $Database -Destination $target
    Write-ScrappyStep "Backup saved: $target"
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
    # Older Windows 10 installs don't offer TLS 1.2 by default, and GitHub requires it.
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
    $database = Get-ScrappyDatabase $InstallRoot

    try {
        # 1. Get the zip.
        $downloaded = $false
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
            Invoke-WebRequest -Uri $url -OutFile $ZipPath -UseBasicParsing
            $downloaded = $true
        }

        # 2. Stop the running app, if any, so its files can be replaced.
        $stopped = Stop-ScrappyProcesses $InstallRoot
        if ($stopped -gt 0) { Write-ScrappyStep 'Closed the running copy of Scrappy Records.' }

        # 3. Back up the data before changing anything.
        if (Test-Path -LiteralPath $database) {
            Write-ScrappyStep 'Saving a backup copy of your data...'
            Backup-ScrappyData $appDir $database
        }

        # 4. Unpack next to the current copy, then swap.
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

        Write-ScrappyStep "Installing version $newVersion..."
        Remove-ScrappyFolder $oldDir
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
        Remove-ScrappyFolder $oldDir -BestEffort

        # 5. Desktop shortcut.
        Write-ScrappyStep 'Creating the Desktop shortcut...'
        if (-not $ShortcutDir) { $ShortcutDir = [Environment]::GetFolderPath('Desktop') }
        if (-not $ShortcutDir) { $ShortcutDir = Join-Path $env:USERPROFILE 'Desktop' }
        New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
        $pythonw = Join-Path $appDir 'python\pythonw.exe'
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $ShortcutDir 'Scrappy Records.lnk'))
        $shortcut.TargetPath = $pythonw
        $shortcut.Arguments = '-m app.launcher'
        $shortcut.WorkingDirectory = $appDir
        $shortcut.IconLocation = (Join-Path $appDir 'scrappy.ico') + ',0'
        $shortcut.Description = 'Open Scrappy Records'
        $shortcut.Save()

        # 6. Tidy up and open the app.
        if ($downloaded) { Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue }
        if (-not $NoLaunch) {
            Write-ScrappyStep 'Opening Scrappy Records in your browser...'
            Start-Process -FilePath $pythonw -ArgumentList '-m', 'app.launcher' -WorkingDirectory $appDir
        }
    } finally {
        if (-not $homeWasSet) { Remove-Item Env:SCRAPPY_HOME -ErrorAction SilentlyContinue }
    }

    Write-Host ''
    Write-Host 'Scrappy Records is installed' -ForegroundColor Green
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
