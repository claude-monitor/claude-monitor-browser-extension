param(
    [string]$Version,
    [switch]$Sign,
    [string]$KeyId
)

$ErrorActionPreference = 'Stop'

if (-not $Version) {
    $manifest = Get-Content -Raw -Path 'claudetrack/manifest.json' | ConvertFrom-Json
    $Version = $manifest.version
}

# Release artifacts produced by Generate_zip_extensions_all_platforms.ps1.
$zips = @(
    "claude-usage-monitor-chrome-v$Version.zip",
    "claude-usage-monitor-firefox-v$Version.zip"
) | Where-Object { Test-Path $_ }

if ($zips.Count -eq 0) {
    throw "No release ZIPs found for v$Version. Run Generate_zip_extensions_all_platforms.ps1 -Version $Version first."
}

$sumsFile = "SHA256SUMS-v$Version.txt"

# coreutils-compatible lines: "<lowercase-hash><two spaces><filename>"
$lines = foreach ($z in $zips) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $z).Hash.ToLower()
    "$hash  $(Split-Path $z -Leaf)"
}

# LF endings, no BOM, so `sha256sum -c` works on Linux/macOS too.
$content = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $sumsFile), $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Output "Wrote $sumsFile"
$lines | ForEach-Object { Write-Output "  $_" }

if ($Sign) {
    $sigFile = "$sumsFile.asc"
    if (Test-Path $sigFile) { Remove-Item $sigFile }

    $gpgArgs = @('--armor', '--detach-sign')
    if ($KeyId) { $gpgArgs += @('--local-user', $KeyId) }
    $gpgArgs += @('--output', $sigFile, $sumsFile)

    # Resolve gpg: PATH first, then Gpg4win (native, owns the keyboxd keyring),
    # then the copy bundled with Git for Windows.
    $gpg = (Get-Command gpg -ErrorAction SilentlyContinue).Source
    if (-not $gpg) {
        foreach ($cand in @(
            'C:\Program Files\GnuPG\bin\gpg.exe',
            'C:\Program Files (x86)\GnuPG\bin\gpg.exe',
            (Join-Path (Split-Path (Split-Path (Get-Command git).Source -Parent) -Parent) 'usr\bin\gpg.exe')
        )) {
            if (Test-Path $cand) { $gpg = $cand; break }
        }
    }
    if (-not $gpg) { throw "gpg not found (PATH, Gpg4win, or Git for Windows)." }

    & $gpg @gpgArgs
    if ($LASTEXITCODE -ne 0) { throw "gpg signing failed (exit $LASTEXITCODE)." }

    Write-Output ""
    Write-Output "Signed -> $sigFile"
    Write-Output "Verify with:  gpg --verify $sigFile $sumsFile"
}
