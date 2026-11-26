$ErrorActionPreference = 'Stop'

# The npm install lives in this package's tools folder, which Chocolatey deletes
# on uninstall; only the launcher in Chocolatey's bin folder needs removing, and
# only if it still carries this package's marker line.
$launcher = Join-Path $env:ChocolateyInstall 'bin\backupdrill.cmd'
$marker = 'rem backupdrill Chocolatey package launcher'
if ((Test-Path $launcher) -and ((Get-Content $launcher -TotalCount 2) -contains $marker)) {
  Remove-Item $launcher -Force
}
