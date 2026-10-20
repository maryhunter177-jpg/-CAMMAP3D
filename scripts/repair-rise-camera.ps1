$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $workspace 'artifacts'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$instance = 'USB\VID_6239&PID_5309\01.00.00'
$reportPath = Join-Path $artifactDir 'rise-device-repair.json'
$report = [ordered]@{ instance = $instance; operation = 'Recreate only Rise Mode device instances; preserve driver packages'; completed = $false }
try {
    $device = Get-PnpDevice -InstanceId $instance -ErrorAction Stop
    if ($device.InstanceId -cne $instance) { throw 'Unexpected device instance; no changes performed.' }
    $report.before = @(Get-PnpDevice | Where-Object { $_.InstanceId -match '^USB\\VID_6239&PID_5309(?:&|\\)' } | Select-Object Status, Class, FriendlyName, InstanceId)
    $report.backupOutput = (& reg.exe export 'HKLM\SYSTEM\CurrentControlSet\Enum\USB\VID_6239&PID_5309' (Join-Path $artifactDir 'rise-device-before.reg') /y 2>&1 | Out-String)
    $report.backupExitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'Device settings backup failed; no removal performed.' }
    $report.removeOutput = (& pnputil.exe /remove-device $instance /subtree 2>&1 | Out-String)
    $report.removeExitCode = $LASTEXITCODE
    $report.scanOutput = (& pnputil.exe /scan-devices 2>&1 | Out-String)
    $report.scanExitCode = $LASTEXITCODE
    $report.after = @(Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in @('Camera', 'Image') -or $_.InstanceId -match '^USB\\VID_6239&PID_5309(?:&|\\)' } | Select-Object Status, Class, FriendlyName, InstanceId)
    $report.risePresent = [bool]($report.after | Where-Object { $_.InstanceId -match '^USB\\VID_6239&PID_5309(?:&|\\)' })
    $report.completed = $true
} catch {
    $report.error = $_.Exception.Message
} finally {
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
}
