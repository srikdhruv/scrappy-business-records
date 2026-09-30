# After a release is published: install it the way the user will, on a fresh Windows machine.
#
# Runs the literal install line from the docs (TLS prefix, `irm` of main's install.ps1 from
# raw.githubusercontent.com, `| iex`), which downloads the release asset from
# releases/latest/download/. Then: the app opens, data survives a restart, re-running the line
# (the update) keeps the data and takes a backup, and the `-Version <tag>` form works.
# Installs into the real %LOCALAPPDATA%\ScrappyRecords and Desktop of the (throwaway) CI machine.
#
#   powershell -NoProfile -File scripts\ci\verify_release_windows.ps1 -Tag v0.1.0
# Pure ASCII, like install.ps1.

param(
    [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$url = 'https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1'
$tls = '[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072'
# Exactly what docs/runbooks/install-windows.md tells the user to paste.
$installLine = "$tls; irm $url | iex"
$versionLine = "$tls; & ([scriptblock]::Create((irm $url))) -Version $Tag"

$root = Join-Path $env:LOCALAPPDATA 'ScrappyRecords'
$appDir = Join-Path $root 'app'
$database = Join-Path $root 'data\records.db'
$python = Join-Path $appDir 'python\python.exe'
$pythonw = Join-Path $appDir 'python\pythonw.exe'
$probe = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'db_probe.py')).Path
$backups = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'ScrappyRecords Backups'
$name = 'Ananya Rao (release check)'

function Step([string]$Message) { Write-Host ''; Write-Host "=== $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { throw "RELEASE CHECK FAILED: $Message" }

function Invoke-FreshPowerShell([string]$Script) {
    $ErrorActionPreference = 'Continue'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    $output = & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $output
    if ($code -ne 0 -or $output -notmatch 'Scrappy Records is installed') { Fail "the install line failed: $Script" }
}

function Get-Health {
    $client = New-Object Net.WebClient
    $client.Proxy = $null
    try { return ($client.DownloadString('http://127.0.0.1:8765/api/health') | ConvertFrom-Json) }
    catch { return $null }
    finally { $client.Dispose() }
}

function Wait-Health {
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $health = Get-Health
        if ($health -and $health.app -eq 'scrappy-records') { return $health }
        Start-Sleep -Milliseconds 500
    }
    Fail 'the app did not answer on http://127.0.0.1:8765'
}

function Invoke-Probe([string]$Action, [string]$Db, [string]$Name = '') {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $python
    $psi.Arguments = "`"$probe`" $Action `"$Db`"" + $(if ($Name) { " `"$Name`"" } else { '' })
    $psi.UseShellExecute = $false
    $proc = [Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    return $proc.ExitCode
}

function Stop-App {
    Get-Process -Name pythonw -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($appDir + '\', [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Health) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
}

$expected = $Tag.TrimStart('v')

Step "The install line, exactly as published (expecting version $expected)"
Invoke-FreshPowerShell $installLine
$health = Wait-Health
if ($health.version -ne $expected) { Fail "installed version $($health.version), expected $expected" }
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Scrappy Records.lnk'
if (-not (Test-Path -LiteralPath $shortcut)) { Fail "no Desktop shortcut at $shortcut" }

Step 'Add a student, restart with the shortcut, still there'
if ((Invoke-Probe insert $database $name) -ne 0) { Fail 'insert failed' }
Stop-App
$lnk = (New-Object -ComObject Shell.Application).Namespace((Split-Path -Parent $shortcut)).ParseName('Scrappy Records.lnk').GetLink
Start-Process -FilePath $lnk.Path -ArgumentList $lnk.Arguments -WorkingDirectory $lnk.WorkingDirectory
Wait-Health | Out-Null
if ((Invoke-Probe check $database $name) -ne 0) { Fail 'the student did not survive a restart' }

Step 'Run the install line again (the update): data kept, backup taken'
Invoke-FreshPowerShell $installLine
Wait-Health | Out-Null
if ((Invoke-Probe check $database $name) -ne 0) { Fail 'the student did not survive the update' }
$preUpdate = @(Get-ChildItem -LiteralPath $backups -Filter 'records-pre-update-*.db' -ErrorAction SilentlyContinue)
if ($preUpdate.Count -lt 1) { Fail "no pre-update backup in $backups" }

Step "The -Version $Tag form"
Invoke-FreshPowerShell $versionLine
$health = Wait-Health
if ($health.version -ne $expected) { Fail "-Version installed $($health.version)" }
if ((Invoke-Probe check $database $name) -ne 0) { Fail 'the student did not survive -Version' }

Stop-App
Write-Host ''
Write-Host 'RELEASE CHECK PASSED' -ForegroundColor Green
