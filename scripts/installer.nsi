; DeepSeek Harness — NSIS graphical installer (Modern UI 2).
;
; Produces a classic Windows wizard installer: welcome -> install directory ->
; progress -> finish (with "Run DeepSeek Harness"). Installs per-user, creates
; Desktop + Start Menu shortcuts, an uninstall entry, and the DPI-awareness
; AppCompat flag that keeps the WebView2 UI crisp on scaled displays.
;
; NOTE: installer UI text is English because the bundled NSIS is the ANSI
; (2.x) build, which cannot encode CJK correctly on all Windows locales. A
; Chinese installer needs NSIS 3.x (Unicode) or Inno Setup 6.
;
; Build with: makensis installer.nsi  (after `pnpm build:stable`)

!include "MUI2.nsh"

!define APP_NAME "DeepSeek Harness"
!define APP_VERSION "0.1.0"
!define APP_ID "ai.deepseek.dsh-desktop"
!define APP_EXE "bin\launcher.exe"
!define APP_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define APPCOMPAT_KEY "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "..\artifacts\DeepSeek Harness-Installer.exe"
InstallDir "$LOCALAPPDATA\Programs\DeepSeek Harness"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "..\resources\icons\app.ico"
!define MUI_UNICON "..\resources\icons\app.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Main" SecMain
  SetOutPath "$INSTDIR"
  File /r "..\build\stable-win-x64\_app\*"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  ; Force DPI awareness so the WebView2 UI renders crisply (not bitmap-scaled)
  ; on scaled displays. Takes effect the next time the app starts.
  WriteRegStr HKCU "${APPCOMPAT_KEY}" "$INSTDIR\bin\bun.exe" "HIGHDPIAWARE"
  WriteRegStr HKCU "${APPCOMPAT_KEY}" "$INSTDIR\bin\launcher.exe" "HIGHDPIAWARE"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "Publisher" "DeepSeek"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${APP_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${APP_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_UNINSTALL_KEY}" "NoRepair" 1
  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegValue HKCU "${APPCOMPAT_KEY}" "$INSTDIR\bin\bun.exe"
  DeleteRegValue HKCU "${APPCOMPAT_KEY}" "$INSTDIR\bin\launcher.exe"
  DeleteRegKey HKCU "${APP_UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${APP_ID}"
SectionEnd
