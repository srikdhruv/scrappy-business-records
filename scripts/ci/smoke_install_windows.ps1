# End-to-end check of the Windows install, as a laptop with nothing installed would get it.
# Run it in Windows PowerShell 5.1 (the version every Windows 10/11 laptop has):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke_install_windows.ps1 -ZipPath dist\scrappy-records-windows-x64.zip
#
# CI runs this in the windows-install job. It installs into a temporary folder whose name has a
# space, an apostrophe and non-English letters (never the real %LOCALAPPDATA%), with PATH cut
# down to Windows' own folders so no Python or uv can be used by accident. Every installer run
# happens in a fresh `powershell.exe` with default settings, as a user's window would be.
# Needs internet access for one check (a release that doesn't exist must give a friendly 404).
# See docs/runbooks/development.md "Testing the install" for the list of checks.
# Pure ASCII, like install.ps1.

param(
    [Parameter(Mandatory = $true)][string]$ZipPath
)

$ErrorActionPreference = 'Stop'  # for this test's own steps; installer runs don't inherit it
$ProgressPreference = 'SilentlyContinue'

$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$installer = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\install.ps1')).Path
$probe = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'db_probe.py')).Path
# "Scrappy Elève's रिकॉर्ड <random>": a space, an apostrophe and non-ASCII (built from char codes
# because this file must stay ASCII).
$awkward = 'Scrappy El' + [char]0x00E8 + "ve's " + [char]0x0930 + [char]0x093F + [char]0x0915 +
    [char]0x0949 + [char]0x0930 + [char]0x094D + [char]0x0921 + ' ' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$work = Join-Path ([IO.Path]::GetTempPath()) $awkward
$root = Join-Path $work 'ScrappyRecords'
$appDir = Join-Path $root 'app'
$backups = Join-Path $work 'backups'
$shortcuts = Join-Path $work 'Desktop'
$database = Join-Path $root 'data\records.db'
$serverLog = Join-Path $root 'logs\server.log'
$python = Join-Path $appDir 'python\python.exe'
$pythonw = Join-Path $appDir 'python\pythonw.exe'
$port = 8765
$name = 'Kabir Mehta (smoke test)'
$tls = '[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072'

function Step([string]$Message) { Write-Host ''; Write-Host "=== $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { throw "SMOKE TEST FAILED: $Message" }
function Quote([string]$Text) { return "'" + $Text.Replace("'", "''") + "'" }

function Invoke-FreshPowerShell([string]$Script) {
    # A new Windows PowerShell 5.1 process with default settings (no -ExecutionPolicy, default
    # $ErrorActionPreference), like the window a user pastes the install line into.
    $ErrorActionPreference = 'Continue'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    $output = & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $output
    return @{ ExitCode = $code; Output = $output }
}

function Install-LikeAUser {
    # The user's exact line, with the local file instead of `irm <url>`.
    return Invoke-FreshPowerShell "$tls; Get-Content -Raw -LiteralPath $(Quote $installer) | iex"
}

function Get-Health {
    $client = New-Object Net.WebClient
    $client.Proxy = $null
    try { return ($client.DownloadString("http://127.0.0.1:$port/api/health") | ConvertFrom-Json) }
    catch { return $null }
    finally { $client.Dispose() }
}

function Wait-Health([int]$Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $health = Get-Health
        if ($health -and $health.app -eq 'scrappy-records') { return $health }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $serverLog) { Get-Content -LiteralPath $serverLog -Tail 40 | Write-Host }
    Fail "no answer from /api/health within $Seconds s"
}

function Start-Program([string]$File, [string]$Arguments, [string]$Directory) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $Directory
    $psi.UseShellExecute = $false
    return [Diagnostics.Process]::Start($psi)
}

function Invoke-Program([string]$File, [string]$Arguments, [string]$Directory = $env:TEMP) {
    $proc = Start-Program $File $Arguments $Directory
    if (-not $proc.WaitForExit(180000)) { Fail "$File $Arguments did not finish" }
    return $proc.ExitCode
}

function Get-ServerProcesses {
    return @(Get-Process -Name pythonw -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
    })
}

function Stop-Server {
    Get-ServerProcesses | Stop-Process -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Health) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (Get-Health) { Fail 'the server did not stop' }
}

function Invoke-Probe([string]$Action, [string]$Db, [string]$Name = '') {
    $arguments = "`"$probe`" $Action `"$Db`""
    if ($Name) { $arguments += " `"$Name`"" }
    return (Invoke-Program $python $arguments)
}

function Assert-Student([string]$Db) {
    if ((Invoke-Probe check $Db $name) -ne 0) { Fail "the test student is missing from $Db" }
}

function Assert-LogContains([string]$Pattern, [string]$Why) {
    if (-not (Select-String -LiteralPath $serverLog -Pattern $Pattern -SimpleMatch -Quiet)) {
        Get-Content -LiteralPath $serverLog -Tail 40 | Write-Host
        Fail "server.log does not show: $Why"
    }
}

try {
    Step "Clean environment: only Windows on PATH, no Python or uv; install folder: $root"
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    foreach ($var in 'VIRTUAL_ENV', 'PYTHONPATH', 'PYTHONHOME', 'UV_PYTHON', 'UV_CACHE_DIR') {
        Remove-Item "Env:$var" -ErrorAction SilentlyContinue
    }
    foreach ($tool in 'python', 'python3', 'uv', 'pip') {
        $found = Get-Command $tool -ErrorAction SilentlyContinue
        if ($found) { Fail "$tool is still reachable at $($found.Source)" }
    }
    if (Get-Health) { Fail "something is already answering on port $port" }
    $env:SCRAPPY_HOME = $root
    $env:SCRAPPY_BACKUP_DIR = $backups
    $env:SCRAPPY_NO_BROWSER = '1'
    $env:SCRAPPY_NO_DIALOG = '1'
    Remove-Item Env:SCRAPPY_PORT -ErrorAction SilentlyContinue

    Step 'A release that does not exist gives the friendly "not found" message (real download)'
    $env:SCRAPPY_INSTALL_VERSION = 'v0.0.0-no-such-release'
    $env:SCRAPPY_INSTALL_ROOT = $root
    $result = Install-LikeAUser
    Remove-Item Env:SCRAPPY_INSTALL_VERSION
    if ($result.ExitCode -eq 0) { Fail 'installing a missing release should fail' }
    if ($result.Output -notmatch 'NOT installed') { Fail 'no "NOT installed" message' }
    if ($result.Output -notmatch 'The download was not found') { Fail 'no friendly 404 hint' }
    if (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) 'scrappy-records-windows-x64.zip')) {
        Fail 'the failed download was left in %TEMP%'
    }
    if (Test-Path -LiteralPath $appDir) { Fail 'a failed install created the app folder' }

    Step 'Install with the one-line form (TLS prefix; script text piped into iex)'
    $env:SCRAPPY_INSTALL_ZIP = $ZipPath
    $env:SCRAPPY_SHORTCUT_DIR = $shortcuts
    $env:SCRAPPY_NO_LAUNCH = '1'
    $result = Install-LikeAUser
    if ($result.ExitCode -ne 0 -or $result.Output -notmatch 'Scrappy Records is installed') {
        Fail 'the installer did not finish'
    }
    if ($result.Output -match 'Note:') { Fail 'the install printed a warning' }
    foreach ($var in 'SCRAPPY_INSTALL_ZIP', 'SCRAPPY_INSTALL_ROOT', 'SCRAPPY_SHORTCUT_DIR', 'SCRAPPY_NO_LAUNCH') {
        Remove-Item "Env:$var"
    }
    if (-not (Test-Path -LiteralPath $ZipPath)) { Fail 'the installer deleted a zip it did not download' }

    Step 'The shortcut points at pythonw -m app.launcher, with the icon; no data folder yet'
    $lnkPath = Join-Path $shortcuts 'Scrappy Records.lnk'
    if (-not (Test-Path -LiteralPath $lnkPath)) { Fail "no shortcut at $lnkPath" }
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
    if ($lnk.TargetPath -ne $pythonw) { Fail "shortcut target is $($lnk.TargetPath)" }
    if ($lnk.Arguments -ne '-m app.launcher') { Fail "shortcut arguments are $($lnk.Arguments)" }
    if ($lnk.WorkingDirectory -ne $appDir) { Fail "shortcut folder is $($lnk.WorkingDirectory)" }
    if ($lnk.IconLocation -notlike '*scrappy.ico,0') { Fail "shortcut icon is $($lnk.IconLocation)" }
    if (-not (Test-Path -LiteralPath (Join-Path $appDir 'scrappy.ico'))) { Fail 'scrappy.ico is missing' }
    if (Test-Path -LiteralPath (Join-Path $root 'data')) { Fail 'installing created the data folder' }
    $version = (Get-Content -LiteralPath (Join-Path $appDir 'VERSION') -TotalCount 1).Trim()

    Step 'pythonw.exe -m app (no console at all) serves /api/health and writes server.log'
    $server = Start-Program $pythonw '-m app' $appDir
    $health = Wait-Health
    if ($health.version -ne $version) { Fail "health says version $($health.version), VERSION says $version" }
    if (-not (Test-Path -LiteralPath $database)) { Fail 'the database was not created' }
    Assert-LogContains 'Application startup complete' 'the startup'

    Step 'A second server for the same data exits cleanly instead of competing'
    $code = Invoke-Program $pythonw '-m app' $appDir
    if ($code -ne 0) { Fail "the second server exited with $code, expected 0" }
    Assert-LogContains 'already running or starting' 'the second server stepping aside'
    if ($server.HasExited) { Fail 'the first server stopped' }
    Stop-Server

    Step 'The launcher, run twice at once from another folder, starts exactly one server'
    $a = Start-Program $pythonw '-m app.launcher' $env:TEMP
    $b = Start-Program $pythonw '-m app.launcher' $env:TEMP
    foreach ($launcher in $a, $b) {
        if (-not $launcher.WaitForExit(120000)) { Fail 'a launcher did not finish' }
        if ($launcher.ExitCode -ne 0) { Get-Content -LiteralPath $serverLog -Tail 40 | Write-Host; Fail "a launcher exited with $($launcher.ExitCode)" }
    }
    Wait-Health | Out-Null
    $servers = Get-ServerProcesses
    if ($servers.Count -ne 1) { Fail "expected 1 server process, found $($servers.Count)" }

    Step 'Add a student with the bundled Python, restart, and check it is still there'
    if ((Invoke-Probe insert $database $name) -ne 0) { Fail 'insert failed' }
    Stop-Server
    if ((Invoke-Program $pythonw '-m app.launcher' 'C:\') -ne 0) { Fail 'the launcher failed after a restart' }
    Wait-Health | Out-Null
    Assert-Student $database
    # Taken by the first start that found a database (before the student was added), so just
    # check it's a sound copy. The pre-update backup below proves the contents.
    $daily = Join-Path $backups ('records-{0}.db' -f (Get-Date -Format 'yyyy-MM-dd'))
    if (-not (Test-Path -LiteralPath $daily)) { Fail "no daily backup at $daily" }
    if ((Invoke-Probe valid $daily) -ne 0) { Fail "$daily is not a sound copy" }

    Step 'Update while the app is running (-Param form): polite stop, backup, data kept'
    $oldServer = (Get-ServerProcesses)[0].Id
    $result = Invoke-FreshPowerShell ("$tls; & ([scriptblock]::Create((Get-Content -Raw -LiteralPath $(Quote $installer)))) " +
        "-ZipPath $(Quote $ZipPath) -InstallRoot $(Quote $root) -ShortcutDir $(Quote $shortcuts)")
    if ($result.ExitCode -ne 0 -or $result.Output -notmatch 'Scrappy Records is installed') { Fail 'the update did not finish' }
    if ($result.Output -notmatch 'Closed the running copy') { Fail 'the update did not stop the app' }
    Assert-LogContains 'Stopping: the installer asked' 'a polite stop (not a kill)'
    # Without -NoLaunch, the installer opens the app itself.
    Wait-Health | Out-Null
    if (Get-Process -Id $oldServer -ErrorAction SilentlyContinue) { Fail 'the old server is still running' }
    $preUpdate = @(Get-ChildItem -LiteralPath $backups -Filter 'records-pre-update-*.db')
    if ($preUpdate.Count -ne 1) { Fail "expected 1 pre-update backup, found $($preUpdate.Count)" }
    Assert-Student $preUpdate[0].FullName
    Assert-Student $database
    foreach ($leftover in 'app.new', 'app.old') {
        if (Test-Path -LiteralPath (Join-Path $root $leftover)) { Fail "$leftover was left behind" }
    }

    Step 'Update after a crash mid-save (a hot records.db-journal): backup and startup still work'
    Stop-Server
    if ((Invoke-Probe hot-journal $database) -ne 0) { Fail 'could not leave a hot journal' }
    if (-not (Test-Path -LiteralPath "$database-journal")) { Fail 'no journal was left behind' }
    $env:SCRAPPY_INSTALL_ZIP = $ZipPath
    $env:SCRAPPY_INSTALL_ROOT = $root
    $env:SCRAPPY_SHORTCUT_DIR = $shortcuts
    $result = Install-LikeAUser
    foreach ($var in 'SCRAPPY_INSTALL_ZIP', 'SCRAPPY_INSTALL_ROOT', 'SCRAPPY_SHORTCUT_DIR') { Remove-Item "Env:$var" }
    if ($result.ExitCode -ne 0) { Fail 'the update after a crash failed' }
    if ($result.Output -match 'file copy') { Fail "the app's own backup should have handled the journal" }
    Wait-Health | Out-Null
    Assert-Student $database
    $newest = Get-ChildItem -LiteralPath $backups -Filter 'records-pre-update-*.db' | Sort-Object Name | Select-Object -Last 1
    if ((Invoke-Probe valid $newest.FullName) -ne 0) { Fail 'the pre-update backup contains the half-saved change' }
    Assert-Student $newest.FullName

    Step "Port $port taken by another program: the launcher fails politely and says why"
    Stop-Server
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
    $listener.Start()  # accepts connections but never answers
    try {
        $code = Invoke-Program $pythonw '-m app.launcher' $env:TEMP
        if ($code -ne 1) { Fail "the launcher exited with $code, expected 1" }
        Assert-LogContains "Something else is using port $port" 'the port clash (launcher)'
        if (Get-ServerProcesses) { Fail 'the launcher started a server anyway' }

        # And the server itself, if started anyway, logs why it stopped.
        $code = Invoke-Program $pythonw '-m app' $appDir
        if ($code -eq 0) { Fail 'the server should have stopped with an error' }
        Assert-LogContains 'error while attempting to bind' 'the port clash (server)'
    } finally {
        $listener.Stop()
    }

    Step 'A failing one-line install reports the problem and does not close the window'
    $env:SCRAPPY_INSTALL_ZIP = Join-Path $work 'no-such-file.zip'
    $env:SCRAPPY_INSTALL_ROOT = $root
    # If the installer called `exit`, this fresh PowerShell would end before printing STILL ALIVE.
    $result = Invoke-FreshPowerShell ("$tls; try { Get-Content -Raw -LiteralPath $(Quote $installer) | iex } " +
        "catch { Write-Output ('CAUGHT: ' + `$_) }; Write-Output 'STILL ALIVE'")
    Remove-Item Env:SCRAPPY_INSTALL_ZIP, Env:SCRAPPY_INSTALL_ROOT
    if ($result.Output -notmatch 'NOT installed') { Fail 'no friendly failure message' }
    if ($result.Output -notmatch 'CAUGHT: Scrappy Records was not installed') { Fail 'the failure was not a catchable error' }
    if ($result.Output -notmatch 'STILL ALIVE') { Fail 'the PowerShell session ended (the window would close)' }
    Assert-Student $database

    Write-Host ''
    Write-Host 'SMOKE TEST PASSED' -ForegroundColor Green
} finally {
    Get-ServerProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}
