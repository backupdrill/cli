$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# A Chocolatey-only fix of this package adds a fourth segment (2.11.2.20261201);
# npm only knows the first three.
$npmVersion = ($env:ChocolateyPackageVersion -split '\.')[0..2] -join '.'

$nodeDir = Join-Path $env:ProgramFiles 'nodejs'
$node = Join-Path $nodeDir 'node.exe'
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) { throw "npm not found at $npm. Install the nodejs-lts package first." }

# Install into the package folder instead of npm's global folder, so the command
# works for every user and never replaces a copy someone installed with npm -g.
# Pin the public registry; no dependency needs install scripts, so turn them off.
$appDir = Join-Path $toolsDir 'app'
& $npm install --prefix $appDir --registry https://registry.npmjs.org/ --ignore-scripts --omit=dev --no-audit --no-fund "backupdrill@$npmVersion"
if ($LASTEXITCODE -ne 0) { throw "npm install backupdrill@$npmVersion failed with exit code $LASTEXITCODE" }

$entry = Join-Path $appDir 'node_modules\backupdrill\dist\index.js'
if (-not (Test-Path $entry)) { throw "backupdrill entry point not found at $entry" }

# Chocolatey's bin folder is on the machine PATH.
$launcher = Join-Path $env:ChocolateyInstall 'bin\backupdrill.cmd'
Set-Content -Path $launcher -Encoding Ascii -Value "@`"$node`" `"$entry`" %*"
