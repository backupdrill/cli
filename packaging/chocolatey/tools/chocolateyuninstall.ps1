$ErrorActionPreference = 'Stop'

# The npm install lives in this package's tools folder, which Chocolatey deletes
# on uninstall; only the shim in Chocolatey's bin folder needs removing.
$nodeDir = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Node.js' -Name InstallPath -ErrorAction SilentlyContinue).InstallPath
if (-not $nodeDir) { $nodeDir = Join-Path $env:ProgramFiles 'nodejs' }
Uninstall-BinFile -Name 'backupdrill' -Path (Join-Path $nodeDir 'node.exe')
