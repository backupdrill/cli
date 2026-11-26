$ErrorActionPreference = 'Stop'

# The package version matches the npm release it installs.
$version = $env:ChocolateyPackageVersion

# nodejs-lts may have been installed in this same choco run, so PATH in this
# session can still be missing it; prefer the default install location.
$npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }

& $npm install --global "backupdrill@$version"
if ($LASTEXITCODE -ne 0) { throw "npm install --global backupdrill@$version failed with exit code $LASTEXITCODE" }
