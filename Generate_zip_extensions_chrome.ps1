param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'

if (-not $Version) {
    $manifest = Get-Content -Raw -Path 'claudetrack/manifest.json' | ConvertFrom-Json
    $Version = $manifest.version
}

$staging = Join-Path $env:TEMP "claudetrack-chrome-$Version"
$zipPath = Join-Path (Get-Location) "claude-usage-monitor-v$Version.zip"

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item -Path 'claudetrack/*' -Destination $staging -Recurse

# Chrome doesn't need the Firefox-specific manifest.
$firefoxManifest = Join-Path $staging 'manifest.firefox.json'
if (Test-Path $firefoxManifest) { Remove-Item $firefoxManifest }

if (Test-Path $zipPath) { Remove-Item $zipPath }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipStream = [System.IO.File]::Create($zipPath)
$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $rootPath = (Resolve-Path $staging).Path.TrimEnd('\') + '\'
    Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($rootPath.Length).Replace('\','/')
        $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $fileStream = [System.IO.File]::OpenRead($_.FullName)
        try { $fileStream.CopyTo($entryStream) }
        finally { $fileStream.Dispose(); $entryStream.Dispose() }
    }
}
finally {
    $archive.Dispose()
    $zipStream.Dispose()
}

Remove-Item -Recurse -Force $staging

Write-Output "Built $zipPath"
