Unicode true
!include "MUI2.nsh"

Name "Pulse URL"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Programs\Pulse URL"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL"
!define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"
!define MUI_LANGDLL_ALWAYSSHOW
!define MUI_LANGDLL_ALLLANGUAGES
!define MUI_LANGDLL_WINDOWTITLE "Язык установки / Installer language"
!define MUI_LANGDLL_INFO "Выберите язык / Choose your language"
!define MUI_CUSTOMFUNCTION_GUIINIT RequireClosed
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.RequireClosed
!insertmacro MUI_RESERVEFILE_LANGDLL
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

LangString AppRunning ${LANG_RUSSIAN} "Завершите Пульс URL через команду «Выход» в меню приложения и повторите операцию."
LangString AppRunning ${LANG_ENGLISH} "Choose Quit from the Pulse URL application menu, then try again."

!macro RequireClosed
  ; The installed executable cannot be opened for writing while its image is mapped.
  IfFileExists "$INSTDIR\Pulse URL.exe" +1 stopped
  StrCpy $1 "$INSTDIR\Pulse URL.exe"
  System::Call 'kernel32::CreateFileW(w r1, i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  IntCmp $0 -1 active
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto stopped
  active:
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(AppRunning)" /SD IDOK
    SetErrorLevel 1
    Quit
  stopped:
!macroend

Function .onInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Pulse URL"
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

Function RequireClosed
  !insertmacro RequireClosed
FunctionEnd

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Function un.RequireClosed
  !insertmacro RequireClosed
FunctionEnd

Section "Pulse URL"
  !insertmacro RequireClosed
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${APP_FILES}"
  CreateDirectory "$SMPROGRAMS\Pulse URL"
  CreateShortCut "$SMPROGRAMS\Pulse URL\Pulse URL.lnk" "$INSTDIR\Pulse URL.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "DisplayName" "Pulse URL"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "DisplayIcon" "$INSTDIR\Pulse URL.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}" $LANGUAGE
SectionEnd

Section "Uninstall"
  !insertmacro RequireClosed
  SetShellVarContext current
  Delete "$SMPROGRAMS\Pulse URL\Pulse URL.lnk"
  RMDir "$SMPROGRAMS\Pulse URL"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL"
  ReadRegStr $0 HKCU "Software\Classes\pulse-url\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\Pulse URL.exe" "%1"' 0 +2
  DeleteRegKey HKCU "Software\Classes\pulse-url"
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ru.pulseurl.desktop"
  StrCmp $0 '"$INSTDIR\Pulse URL.exe"' 0 +3
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ru.pulseurl.desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ru.pulseurl.desktop"
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
