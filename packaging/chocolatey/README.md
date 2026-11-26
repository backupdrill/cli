# Chocolatey package

Source of the [`backupdrill` Chocolatey package](https://community.chocolatey.org/packages/backupdrill). It installs the npm release with the same version number (`npm install --global backupdrill@<version>`), so it depends on `nodejs-lts`.

To release a new version, set `<version>` in `backupdrill.nuspec` to the npm version, then:

```bash
choco pack packaging/chocolatey/backupdrill.nuspec
choco push backupdrill.<version>.nupkg --source https://push.chocolatey.org/
```
