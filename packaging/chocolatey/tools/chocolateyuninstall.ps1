$ErrorActionPreference = 'Stop'

$npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }

& $npm uninstall --global backupdrill
if ($LASTEXITCODE -ne 0) { throw "npm uninstall --global backupdrill failed with exit code $LASTEXITCODE" }
