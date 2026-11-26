# Chocolatey package

Source of the [`backupdrill` Chocolatey package](https://community.chocolatey.org/packages/backupdrill). The install script runs `npm install backupdrill@<version>` into the package folder (public registry, install scripts off) and writes a `backupdrill.cmd` launcher into Chocolatey's `bin` folder, so it depends on `nodejs-lts`. PowerShell can strip quotes before `backupdrill.cmd` receives them, leaving `cmd.exe` to treat `&` as a command separator. If your database URL contains `&`, set `$env:BACKUPDRILL_DATABASE_URL` instead of passing it on the command line.

To release a new version, set `<version>` in `backupdrill.nuspec` to the npm version, pack it with `choco pack`, and push it to https://push.chocolatey.org/. A fix that changes only this package uses a fourth version segment (`2.11.2.20261201`); the install script drops it when it calls npm.

The community repository's automated verifier installs and uninstalls every submitted version on a clean Windows machine. We haven't run the package on Windows ourselves, so check its verifier result before approving a release.
