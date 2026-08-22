; DeepSeek Harness — NSIS 3.x (Unicode) graphical installer (Modern UI 2).
;
; Produces a classic Windows wizard installer with a Simplified-Chinese UI:
; welcome -> install directory -> progress -> finish (with "Run"). Installs
; per-user, creates Desktop + Start Menu shortcuts, an uninstall entry, and
; the DPI-awareness AppCompat flag that keeps the WebView2 UI crisp on scaled
; displays.
;
; Requires NSIS 3.x (Unicode): the old ANSI (2.x) makensis cannot encode CJK.
; This script is saved as UTF-8 with a BOM so NSIS 3 reads the Chinese strings
; correctly.
;
; Build with: "…\nsis-3.10\makensis.exe" installer.nsi  (after `pnpm build:stable`)

Unicode true

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

; Chinese welcome/finish copy (SimpChinese). The rest of the wizard text comes
; from MUI_LANGUAGE "SimpChinese" below.
!define MUI_WELCOMEPAGE_TITLE "欢迎使用 DeepSeek Harness 安装向导"
!define MUI_WELCOMEPAGE_TEXT "本向导将引导您完成 DeepSeek Harness 的安装。$\r$\n$\r$\n点击「下一步」继续。"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "DeepSeek Harness 已成功安装到您的计算机。$\r$\n$\r$\n点击「完成」退出安装向导。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; NOTE: section names MUST stay ASCII (English). On machines with aggressive
; security software (Lenovo/Huorong, AlibabaProtect), a Chinese-language
; installer that also embeds Chinese SECTION NAMES ("主程序"/"卸载") gets flagged
; as a suspicious bundle installer and its output is wiped right after install
; (verified empirically: only the section names trigger it; the Chinese wizard
; text/UI is fine). Keep these two names in English.

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
