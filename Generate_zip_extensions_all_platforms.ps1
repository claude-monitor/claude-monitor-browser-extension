param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

& (Join-Path $scriptDir 'Generate_zip_extensions_chrome.ps1')  -Version $Version
& (Join-Path $scriptDir 'Generate_zip_extensions_firefox.ps1') -Version $Version
