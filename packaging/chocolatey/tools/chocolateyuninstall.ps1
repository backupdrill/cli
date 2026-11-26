$ErrorActionPreference = 'Stop'

# The npm install lives in this package's tools folder, which Chocolatey deletes
# on uninstall; only the launcher outside it needs removing.
$launcher = Join-Path $env:ChocolateyInstall 'bin\backupdrill.cmd'
# Only remove the launcher if it still points into this package.
if ((Test-Path $launcher) -and ((Get-Content $launcher -Raw) -like '*\lib\backupdrill\tools\app\*')) {
  Remove-Item $launcher -Force
}
