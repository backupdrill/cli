$ErrorActionPreference = 'Stop'

# The npm install lives in this package's tools folder, which Chocolatey deletes
# on uninstall; only the launcher outside it needs removing.
$launcher = Join-Path $env:ChocolateyInstall 'bin\backupdrill.cmd'
if (Test-Path $launcher) { Remove-Item $launcher -Force }
