$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$reportPath = Join-Path $workspace 'artifacts/camera-rescan.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportPath) | Out-Null
try {
    $scanOutput = & "$env:SystemRoot/System32/pnputil.exe" /scan-devices 2>&1 | Out-String
    $scanExit = $LASTEXITCODE
    $cameras = @(Get-PnpDevice -PresentOnly | Where-Object {
        $_.Class -in @('Camera', 'Image') -or $_.InstanceId -match 'VID_6239&PID_5309'
    } | Select-Object Status, Class, FriendlyName, InstanceId)
    [pscustomobject]@{
        scanExitCode = $scanExit
        scanOutput = $scanOutput
        presentDevices = $cameras
        risePresent = [bool]($cameras | Where-Object { $_.InstanceId -match 'VID_6239&PID_5309' })
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
} catch {
    [pscustomobject]@{ error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8
    exit 1
}
