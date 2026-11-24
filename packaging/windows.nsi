Unicode true
!include "MUI2.nsh"

Name "Pulse URL"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Programs\Pulse URL"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

!macro RequireClosed
  FindWindow $0 "Chrome_WidgetWin_1" "Пульс URL"
  IntCmp $0 0 +1 active active
  IfFileExists "$INSTDIR\Pulse URL.exe" +1 stopped
  StrCpy $1 "$INSTDIR\Pulse URL.exe"
  System::Call 'kernel32::CreateFileW(w r1, i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  IntCmp $0 -1 active
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto stopped
  active:
    MessageBox MB_OK|MB_ICONEXCLAMATION "Завершите Пульс URL через команду «Выход» в меню приложения и повторите операцию." /SD IDOK
    SetErrorLevel 1
    Abort
  stopped:
!macroend

Function .onInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Pulse URL"
  !insertmacro RequireClosed
FunctionEnd

Function un.onInit
  !insertmacro RequireClosed
FunctionEnd

Section "Pulse URL"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${APP_FOLDER}/*.*"
  CreateDirectory "$SMPROGRAMS\Pulse URL"
  CreateShortCut "$SMPROGRAMS\Pulse URL\Pulse URL.lnk" "$INSTDIR\Pulse URL.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "DisplayName" "Pulse URL"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "DisplayIcon" "$INSTDIR\Pulse URL.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseURL" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd

Section "Uninstall"
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
