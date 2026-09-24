# One-step Windows setup for the ClarkReader server.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Finds a Python Kokoro supports (3.10-3.12), builds a venv beside this script, installs
# the server's requirements, builds the extension into dist\, and runs the server in the
# background at every login as the ClarkReaderServer scheduled task. Safe to run again.
# Remove the auto-start with:  install.ps1 -NoAutoStart
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

# Run as a background service: a per-user Scheduled Task (no admin) that starts
# at login, runs with no window and restarts after a crash. It goes through a
# headless conhost because Windows Terminal, when it is the default terminal,
# ignores -WindowStyle Hidden. Log: %LOCALAPPDATA%\ClarkReader\server.log
$taskName = 'ClarkReaderServer'
$logFile = Join-Path $env:LOCALAPPDATA 'ClarkReader\server.log'
$serverScript = Join-Path $here 'server\clarkreader_server.py'
# Older installs started from a Startup-folder shortcut; the task replaces it.
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'ClarkReader server.lnk'
if (Test-Path $link) { Remove-Item $link }
if ($NoAutoStart) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Write-Host 'Auto-start removed.'
} else {
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') `
        -Argument ('--headless "{0}" "{1}" --log-file "{2}"' -f $venvPython, $serverScript, $logFile) `
        -WorkingDirectory $here
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    $settings.ExecutionTimeLimit = 'PT0S'   # never stop it for "running too long"
    Register-ScheduledTask -TaskName $taskName -Action $action -Force `
        -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -Settings $settings `
        -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) `
        -Description 'ClarkReader local Kokoro TTS server on 127.0.0.1:8756.' | Out-Null
    Write-Host "Server runs in the background at login (scheduled task '$taskName', log $logFile)."
}

# Start it now unless it is already answering.
$up = $false
try { $up = (Invoke-RestMethod http://127.0.0.1:8756/health -TimeoutSec 2).ok } catch {}
if (-not $up -and -not $NoAutoStart) {
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Server starting. The first start downloads the voice and takes a couple of minutes.'
}

Write-Host @"

Last step, in your browser:
  Chrome   chrome://extensions -> Developer mode -> Load unpacked -> $here\dist\chrome
  Firefox  about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $here\dist\firefox\manifest.json
"@
