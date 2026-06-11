param(
    [string]$ChromePath
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$generator = Join-Path $scriptDir 'screenshot_helper\store_screenshots.html'
$outDir    = Join-Path $scriptDir 'screenshots'

# Locate a Chromium-based browser for headless rendering.
if (-not $ChromePath) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    $ChromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ChromePath) { throw "No Chrome/Edge found. Pass -ChromePath explicitly." }

# shot id (?shot= URL param) -> output filename
$shots = [ordered]@{
    hero   = '01-overview'
    themes = '02-themes'
    menu   = '03-display-options'
    high   = '04-high-usage'
}

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$staging = Join-Path $env:TEMP 'claudetrack-shots'
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

$srcUrl = 'file:///' + ($generator -replace '\\','/')

foreach ($shot in $shots.Keys) {
    $name = $shots[$shot]
    $png  = Join-Path $staging "$name.png"
    $udd  = Join-Path $staging "profile_$shot"
    & $ChromePath --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
        --window-size=1280,800 --virtual-time-budget=2500 --user-data-dir="$udd" `
        --screenshot="$png" "${srcUrl}?shot=$shot" | Out-Null
    if (-not (Test-Path $png)) { throw "Failed to render shot '$shot'." }
    Copy-Item $png (Join-Path $outDir "$name.png") -Force
}

Remove-Item -Recurse -Force $staging

Write-Output "Wrote $($shots.Count) screenshots to $outDir"
