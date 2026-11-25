param([Parameter(Mandatory)][string]$Folder)
$ErrorActionPreference = 'Stop'

$setup = node packaging/release.cjs checksum $Folder
if ($LASTEXITCODE -ne 0) { throw 'Installer checksum verification failed' }
$installPath = Join-Path $env:LOCALAPPDATA 'Programs\Pulse URL'
$app = Join-Path $installPath 'Pulse URL.exe'
$uninstall = Join-Path $installPath 'Uninstall.exe'
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Pulse URL\Pulse URL.lnk'
if ((Test-Path $installPath) -or (Test-Path $registration) -or (Test-Path $shortcut)) {
  throw 'Desktop smoke requires a clean Windows test account'
}
if ($env:PULSE_PUBLIC_RELEASE -eq '1') {
  node packaging/release.cjs verify-windows $setup
  if ($LASTEXITCODE -ne 0) { throw 'Installer signature verification failed' }
}

function Install-Pulse {
  $install = Start-Process $setup -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Install returned $($install.ExitCode)" }
  if (-not (Test-Path $app) -or -not (Test-Path $registration) -or -not (Test-Path $shortcut)) {
    throw 'Installer did not create the program, uninstall entry and Start menu shortcut'
  }
  $language = Get-ItemPropertyValue -Path $registration -Name InstallerLanguage
  if ($language -notin @('1033', '1049')) { throw "Unexpected installer language $language" }
}

try {
  Install-Pulse
  if ($env:PULSE_PUBLIC_RELEASE -eq '1') {
    node packaging/release.cjs verify-windows $app
    if ($LASTEXITCODE -ne 0) { throw 'Installed application signature verification failed' }
    Remove-Item Env:PULSE_WINDOWS_CERT_THUMBPRINT
  }
  $installedHash = (Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash
  $env:PULSE_SMOKE_EXECUTABLE = $app
  node e2e/desktop-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "Desktop smoke returned $LASTEXITCODE" }
  $env:PULSE_SMOKE_INSTALLER = $setup
  node e2e/desktop-locale-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "Desktop locale smoke returned $LASTEXITCODE" }
  Set-ItemProperty -Path $registration -Name InstallerLanguage -Value '1049'
  Install-Pulse
  if ((Get-ItemPropertyValue -Path $registration -Name InstallerLanguage) -ne '1049') {
    throw 'Silent reinstall did not preserve the Russian installer language'
  }
  if ((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash -ne $installedHash) {
    throw 'In-place reinstallation changed the application bytes'
  }
} finally {
  if (Test-Path $uninstall) {
    $removed = Start-Process $uninstall -ArgumentList '/S' -Wait -PassThru
    if ($removed.ExitCode -ne 0) { throw "Uninstall returned $($removed.ExitCode)" }
  }
  if ((Test-Path $installPath) -or (Test-Path $registration) -or (Test-Path $shortcut)) {
    throw 'Uninstall left the installation directory or Windows entries behind'
  }
}
