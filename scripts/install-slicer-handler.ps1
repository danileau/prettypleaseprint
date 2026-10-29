# Register prusa-open.sh as the handler for `ppp://` links on Windows, and lay
# down a config skeleton for it to read. The Windows twin of
# install-slicer-handler.sh.
#
# Run it once, on the machine that has the printer and the slicer, from a
# checkout of this repository:
#   powershell -ExecutionPolicy Bypass -File scripts\install-slicer-handler.ps1
#
# What it does, all under your own profile - nothing system-wide, no admin:
#   1. copies prusa-open.sh to ~\.local\bin\ppp-open, with LF line endings;
#   2. registers ppp:// under HKCU\Software\Classes\ppp to run that copy;
#   3. creates ~\.config\ppp\slicer.conf for you to fill in, if it is not
#      already there.
# -Uninstall removes 1 and 2 and leaves your slicer.conf alone.
#
# The helper is bash, so this needs Git for Windows, which brings bash, curl
# and mintty. The handler runs it through `mintty -w hide`: a console program
# registered directly flashes a window on every click, and mintty can run
# hidden. It is also what a Chromium browser was seen to launch without
# complaint. Hidden is why prusa-open.sh runs the slicer in the foreground
# under Git Bash: a backgrounded one dies with the terminal.
#
# This file is ASCII on purpose. Windows PowerShell 5.1 reads a script without
# a byte-order mark in the machine's ANSI code page, so one typographic dash in
# here would be a parse error on somebody's machine and not on another's.

[CmdletBinding()]
param([switch]$Uninstall)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceHandler = Join-Path $here 'prusa-open.sh'
$binDir = Join-Path $HOME '.local\bin'
$handler = Join-Path $binDir 'ppp-open'
$confDir = Join-Path $HOME '.config\ppp'
$conf = Join-Path $confDir 'slicer.conf'
$key = 'HKCU:\Software\Classes\ppp'

if ($Uninstall) {
  if (Test-Path $key) { Remove-Item -Path $key -Recurse; Write-Host "removed $key" }
  if (Test-Path $handler) { Remove-Item -Path $handler; Write-Host "removed $handler" }
  Write-Host "Left $conf in place."
  exit 0
}

if (-not (Test-Path $sourceHandler)) { throw "prusa-open.sh is not beside this installer ($sourceHandler)" }

# --- Git for Windows ---------------------------------------------------------
# Its installer records where it went; failing that, git.exe on PATH lives in
# <root>\cmd or <root>\bin. Not found is an error that says what to install,
# not a guess at a default path.
$gitRoot = $null
$recorded = Get-ItemProperty -Path 'HKLM:\SOFTWARE\GitForWindows' -Name InstallPath -ErrorAction SilentlyContinue
if ($recorded) { $gitRoot = $recorded.InstallPath }
if (-not $gitRoot) {
  $gitExe = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($gitExe) { $gitRoot = Split-Path -Parent (Split-Path -Parent $gitExe.Source) }
}
$mintty = if ($gitRoot) { Join-Path $gitRoot 'usr\bin\mintty.exe' } else { $null }
if (-not $gitRoot) {
  throw 'Git for Windows was not found: no install is recorded in the registry and git.exe is not on PATH. Install it from https://gitforwindows.org and run this again.'
}
if (-not (Test-Path $mintty)) {
  throw "Git for Windows at '$gitRoot' has no $mintty. Reinstall it from https://gitforwindows.org and run this again."
}

# --- 1. the helper, as a copy ------------------------------------------------
# A copy, for the reason install-slicer-handler.sh gives: the handler must not
# depend on which branch this checkout is on. Written LF and without a BOM,
# whatever core.autocrlf did to the checkout: bash refuses `set -euo pipefail\r`.
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$text = [IO.File]::ReadAllText($sourceHandler) -replace "`r`n", "`n"
[IO.File]::WriteAllText($handler, $text, (New-Object Text.UTF8Encoding $false))
Write-Host "installed $handler"

# --- 2. the scheme -----------------------------------------------------------
# HKCU rather than HKEY_CLASSES_ROOT: per user, and no admin. bash is given the
# copy's POSIX path (C:\Users\x -> /c/Users/x), and -l so that its PATH has curl.
$posixHandler = '/' + $handler.Substring(0, 1).ToLower() + ($handler.Substring(2) -replace '\\', '/')
$command = '"{0}" -w hide -e /usr/bin/bash -l "{1}" "%1"' -f $mintty, $posixHandler
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(Default)' -Value 'URL:Pretty Please Print'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$key\shell\open\command" -Name '(Default)' -Value $command
Write-Host "registered ppp:// -> $command"

# --- 3. the config -----------------------------------------------------------
if (-not (Test-Path $conf)) {
  New-Item -ItemType Directory -Force -Path $confDir | Out-Null
  $template = @'
# Pretty Please Print - slicer helper config. Read by ~/.local/bin/ppp-open.
#
# There is nothing secret in here. The clicked link carries its own credential,
# so the only thing this file has to say is which instance to talk to, and
# which slicer to open.

# The instance, no trailing slash. This is the only required setting.
PPP_BASE="https://print.example"

# Which slicer: prusa (the default), orca, elegoo, bambu or cura. Only
# PrusaSlicer is handed --single-instance.
# PPP_SLICER_PROFILE=prusa

# Where it is. On Windows every slicer is under a path with spaces, so use
# PPP_SLICER_PATH, which is taken whole, in the /c/... form Git Bash uses:
# PPP_SLICER_PATH="/c/Program Files/Prusa3D/PrusaSlicer/prusa-slicer.exe"
# PPP_SLICER_PATH="/c/Program Files/OrcaSlicer/orca-slicer.exe"
# PPP_SLICER_PATH="/c/Program Files/ElegooSlicer/elegoo-slicer.exe"

# Optional. Where fetched models are cached (pruned after a day).
# PPP_DOWNLOAD_DIR="$HOME/.cache/ppp/models"
'@
  [IO.File]::WriteAllText($conf, ($template -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
  Write-Host "created $conf - set PPP_BASE, PPP_SLICER_PROFILE and PPP_SLICER_PATH"
}

Write-Host ''
Write-Host "Done. Fill in $conf, then click 'Open in PrusaSlicer' on any ticket."
Write-Host 'No token to paste - the link carries its own.'
Write-Host ''
Write-Host "The helper is a copy at $handler. After a git pull, run this again to update it."
Write-Host "Trouble? The log is $HOME\.local\state\ppp\slicer.log"
