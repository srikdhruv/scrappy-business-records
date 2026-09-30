# End-to-end check of the Windows install, as a laptop with nothing installed would get it.
# Run it in Windows PowerShell 5.1 (the version every Windows 10/11 laptop has):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke_install_windows.ps1 -ZipPath dist\scrappy-records-windows-x64.zip
#
# CI runs this in the windows-install job. It installs into a temporary folder (never the real
# %LOCALAPPDATA%), with PATH cut down to Windows' own folders so no Python or uv can be used by
# accident, and checks:
#   install via `| iex` -> shortcut, no data folder -> `pythonw -m app` answers /api/health ->
#   launcher (twice at once: one server) -> add a student -> restart -> still there + daily
#   backup -> reinstall while running (update) -> pre-update backup, still there -> port 8765
#   taken: launcher fails politely, server.log says why -> a failing `| iex` install doesn't
#   close the window.
# Pure ASCII, like install.ps1.

param(
    [Parameter(Mandatory = $true)][string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$installer = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\install.ps1')).Path
$probe = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'db_probe.py')).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('scrappy-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
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

function Step([string]$Message) { Write-Host ''; Write-Host "=== $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { throw "SMOKE TEST FAILED: $Message" }

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
    if (Test-Path $serverLog) { Get-Content $serverLog -Tail 40 | Write-Host }
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

function Assert-Student([string]$Db) {
    $code = Invoke-Program $python "`"$probe`" check `"$Db`" `"$name`""
    if ($code -ne 0) { Fail "the test student is missing from $Db" }
}

function Invoke-InstallerLikeAUser {
    # Exactly the user's form: the script text piped into Invoke-Expression, no arguments.
    $out = & { Get-Content -Raw -LiteralPath $installer | Invoke-Expression } 6>&1 | Out-String
    Write-Host $out
    if ($out -notmatch 'Scrappy Records is installed') { Fail 'the installer did not finish' }
}

try {
    Step 'Clean environment: only Windows on PATH, no Python or uv'
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

    Step 'Install with `Get-Content install.ps1 | iex` (the one-line form)'
    $env:SCRAPPY_INSTALL_ZIP = $ZipPath
    $env:SCRAPPY_INSTALL_ROOT = $root
    $env:SCRAPPY_SHORTCUT_DIR = $shortcuts
    $env:SCRAPPY_NO_LAUNCH = '1'
    Invoke-InstallerLikeAUser
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
    if (-not (Test-Path (Join-Path $appDir 'scrappy.ico'))) { Fail 'scrappy.ico is missing' }
    if (Test-Path (Join-Path $root 'data')) { Fail 'installing created the data folder' }
    $version = (Get-Content (Join-Path $appDir 'VERSION') -TotalCount 1).Trim()

    Step 'pythonw.exe -m app (no console at all) serves /api/health and writes server.log'
    $server = Start-Program $pythonw '-m app' $appDir
    $health = Wait-Health
    if ($health.version -ne $version) { Fail "health says version $($health.version), VERSION says $version" }
    if (-not (Test-Path $database)) { Fail 'the database was not created' }
    if (-not (Select-String -Path $serverLog -Pattern 'Application startup complete' -Quiet)) {
        Fail 'server.log does not show the startup'
    }
    Stop-Server

    Step 'The launcher, run twice at once from another folder, starts exactly one server'
    $a = Start-Program $pythonw '-m app.launcher' $env:TEMP
    $b = Start-Program $pythonw '-m app.launcher' $env:TEMP
    foreach ($launcher in $a, $b) {
        if (-not $launcher.WaitForExit(120000)) { Fail 'a launcher did not finish' }
        if ($launcher.ExitCode -ne 0) { Get-Content $serverLog -Tail 40 | Write-Host; Fail "a launcher exited with $($launcher.ExitCode)" }
    }
    Wait-Health | Out-Null
    $servers = Get-ServerProcesses
    if ($servers.Count -ne 1) { Fail "expected 1 server process, found $($servers.Count)" }

    Step 'Add a student with the bundled Python, restart, and check it is still there'
    if ((Invoke-Program $python "`"$probe`" insert `"$database`" `"$name`"") -ne 0) { Fail 'insert failed' }
    Stop-Server
    if ((Invoke-Program $pythonw '-m app.launcher' 'C:\') -ne 0) { Fail 'the launcher failed after a restart' }
    Wait-Health | Out-Null
    Assert-Student $database
    $daily = Join-Path $backups ('records-{0}.db' -f (Get-Date -Format 'yyyy-MM-dd'))
    if (-not (Test-Path $daily)) { Fail "no daily backup at $daily" }
    Assert-Student $daily

    Step 'Reinstall (the update path) while the app is running, with the -Param form'
    $oldServer = (Get-ServerProcesses)[0].Id
    & ([scriptblock]::Create((Get-Content -Raw -LiteralPath $installer))) `
        -ZipPath $ZipPath -InstallRoot $root -ShortcutDir $shortcuts
    # Without -NoLaunch, the installer opens the app itself.
    Wait-Health | Out-Null
    if (Get-Process -Id $oldServer -ErrorAction SilentlyContinue) { Fail 'the old server is still running' }
    $preUpdate = @(Get-ChildItem $backups -Filter 'records-pre-update-*.db')
    if ($preUpdate.Count -ne 1) { Fail "expected 1 pre-update backup, found $($preUpdate.Count)" }
    Assert-Student $preUpdate[0].FullName
    Assert-Student $database
    foreach ($leftover in 'app.new', 'app.old') {
        if (Test-Path (Join-Path $root $leftover)) { Fail "$leftover was left behind" }
    }

    Step "Port $port taken by another program: the launcher fails politely and says why"
    Stop-Server
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
    $listener.Start()  # accepts connections but never answers
    try {
        $code = Invoke-Program $pythonw '-m app.launcher' $env:TEMP
        if ($code -ne 1) { Fail "the launcher exited with $code, expected 1" }
        if (-not (Select-String -Path $serverLog -Pattern "Something else is using port $port" -Quiet)) {
            Fail 'server.log does not explain the port clash (launcher)'
        }
        if (Get-ServerProcesses) { Fail 'the launcher started a server anyway' }

        # And the server itself, if started anyway, logs why it stopped.
        $code = Invoke-Program $pythonw '-m app' $appDir
        if ($code -eq 0) { Fail 'the server should have stopped with an error' }
        if (-not (Select-String -Path $serverLog -Pattern 'error while attempting to bind' -Quiet)) {
            Get-Content $serverLog -Tail 40 | Write-Host
            Fail 'server.log does not explain the port clash (server)'
        }
    } finally {
        $listener.Stop()
    }

    Step 'A failing `| iex` install reports the problem and does not close the window'
    $env:SCRAPPY_INSTALL_ZIP = Join-Path $work 'no-such-file.zip'
    $env:SCRAPPY_INSTALL_ROOT = $root
    $failedAsExpected = $false
    try {
        Get-Content -Raw -LiteralPath $installer | Invoke-Expression
    } catch {
        $failedAsExpected = $_.Exception.Message -like '*was not installed*'
    }
    Remove-Item Env:SCRAPPY_INSTALL_ZIP, Env:SCRAPPY_INSTALL_ROOT
    if (-not $failedAsExpected) { Fail 'the bad install did not fail the expected way' }
    Write-Host 'Still running after the failed install: the window would have stayed open.'
    Assert-Student $database

    Write-Host ''
    Write-Host 'SMOKE TEST PASSED' -ForegroundColor Green
} finally {
    Get-ServerProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}
