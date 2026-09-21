# One-step Windows setup for the ClarkReader server.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Finds a Python Kokoro supports (3.10-3.12), builds a venv beside this script, installs
# the server's requirements, builds the extension into dist\, and starts the server at
# every login through a shortcut in your Startup folder. Safe to run again.
# Remove the auto-start with:  install.ps1 -NoAutoStart   (or delete the shortcut).
param([switch]$NoAutoStart)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# Kokoro only installs on 3.10-3.12; `py -3` would pick a newer one and fail.
$python = $null
foreach ($v in '3.12', '3.11', '3.10') {
    $exe = & py "-$v" -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe) { $python = "-$v"; $found = $v; break }
}
if (-not $python) {
    throw 'No Python 3.10, 3.11 or 3.12 found. Install Python 3.12 from https://www.python.org/downloads/windows/ and run this again.'
}
Write-Host "Using Python $found"

# PyTorch's file paths are deep; from a deep folder pip fails with a long-path error.
if ($here.Length -gt 60) {
    Write-Warning "This folder path is long ($($here.Length) characters). If the install fails with a 'long path' error, move ClarkReader somewhere short such as C:\ClarkReader."
}

$venv = Join-Path $here '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $venvPython)) { & py $python -m venv $venv; if ($LASTEXITCODE) { throw 'venv creation failed' } }
Write-Host 'Installing the server (PyTorch is a large download the first time)...'
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $here 'server\requirements.txt')
if ($LASTEXITCODE) { throw 'pip install failed' }

& (Join-Path $here 'build.ps1')

# Start at login, hidden, from the Startup folder: per-user, no admin, easy to remove.
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'ClarkReader server.lnk'
if ($NoAutoStart) {
    if (Test-Path $link) { Remove-Item $link }
    Write-Host 'Auto-start removed.'
} else {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = $venvPython
    $sc.Arguments = '"' + (Join-Path $here 'server\clarkreader_server.py') + '"'
    $sc.WorkingDirectory = $here
    $sc.WindowStyle = 7   # minimized
    $sc.Save()
    Write-Host "Server will start at login ($link)."
}

# Start it now unless it is already answering.
$up = $false
try { $up = (Invoke-RestMethod http://127.0.0.1:8756/health -TimeoutSec 2).ok } catch {}
if (-not $up) {
    Start-Process -FilePath $venvPython -ArgumentList ('"' + (Join-Path $here 'server\clarkreader_server.py') + '"') -WorkingDirectory $here -WindowStyle Hidden
    Write-Host 'Server starting. The first start downloads the voice and takes a couple of minutes.'
}

Write-Host @"

Last step, in your browser:
  Chrome   chrome://extensions -> Developer mode -> Load unpacked -> $here\dist\chrome
  Firefox  about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $here\dist\firefox\manifest.json
"@
