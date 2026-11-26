$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# A Chocolatey-only fix of this package adds a fourth segment (2.11.2.20261201);
# npm only knows the first three.
$npmVersion = ($env:ChocolateyPackageVersion -split '\.')[0..2] -join '.'

# Use the machine-wide Node.js that nodejs-lts installs. Its MSI records the
# folder under HKLM\SOFTWARE\Node.js\InstallPath, which can differ from the
# default when Node.js was installed to a custom folder.
$nodeDir = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Node.js' -Name InstallPath -ErrorAction SilentlyContinue).InstallPath
if (-not $nodeDir) { $nodeDir = Join-Path $env:ProgramFiles 'nodejs' }
$node = Join-Path $nodeDir 'node.exe'
# Run the bundled npm-cli.js directly: npm.cmd would prefer an npm from the
# user's own global folder, which the installing admin shouldn't run.
$npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $node)) { throw "This package needs Node.js, but node.exe isn't in $nodeDir. Install the nodejs-lts package, then retry." }
if (-not (Test-Path $npmCli)) { throw "This package needs the npm that comes with Node.js, but it isn't in $nodeDir. Repair or reinstall the nodejs-lts package, then retry." }

# Install into the package folder instead of npm's global folder, so the command
# works for every user and never replaces a copy someone installed with npm -g.
# Point npm at empty user and global config files so an admin's .npmrc can't
# send any package to another registry; no dependency needs install scripts.
$appDir = Join-Path $toolsDir 'app'
$emptyNpmrc = Join-Path $toolsDir 'empty.npmrc'
Set-Content -Path $emptyNpmrc -Value '' -Encoding Ascii
$env:NPM_CONFIG_USERCONFIG = $emptyNpmrc
$env:NPM_CONFIG_GLOBALCONFIG = $emptyNpmrc
# NODE_OPTIONS could preload a module into npm before --ignore-scripts applies.
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
& $node $npmCli install --prefix $appDir --registry https://registry.npmjs.org/ --ignore-scripts --omit=dev --no-audit --no-fund "backupdrill@$npmVersion"
if ($LASTEXITCODE -ne 0) { throw "npm install backupdrill@$npmVersion failed with exit code $LASTEXITCODE" }

$entry = Join-Path $appDir 'node_modules\backupdrill\dist\index.js'
if (-not (Test-Path $entry)) { throw "backupdrill entry point not found at $entry" }

# A .cmd launcher in Chocolatey's bin folder (on the machine PATH), the same
# kind of launcher npm itself writes on Windows. Its marker line lets install
# and uninstall tell it apart from a backupdrill.cmd that came from elsewhere.
$launcher = Join-Path $env:ChocolateyInstall 'bin\backupdrill.cmd'
$marker = 'rem backupdrill Chocolatey package launcher'
if ((Test-Path $launcher) -and -not ((Get-Content $launcher -TotalCount 2) -contains $marker)) {
  throw "A launcher already exists at $launcher. To use this package's launcher, move the existing file aside and retry."
}
Set-Content -Path $launcher -Encoding Ascii -Value @('@echo off', $marker, "`"$node`" `"$entry`" %*")
