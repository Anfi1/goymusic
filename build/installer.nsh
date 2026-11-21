!ifndef BUILD_UNINSTALLER
Var updateLock

!macro customInit
  ${If} ${isUpdated}
    ; При повышении прав замену файлов выполняет внутренний установщик.
    ${If} $hasPerMachineInstallation != 1
    ${OrIf} ${UAC_IsAdmin}
      ; Эксклюзивный handle, OPEN_ALWAYS и FILE_FLAG_DELETE_ON_CLOSE.
      ; Windows снимет блокировку даже при аварийном завершении установщика.
      System::Call 'kernel32::CreateFileW(w "$TEMP\${APP_ID}.update-lock", i 0x40010000, i 0, p 0, i 4, i 0x04000000, p 0) p.r0'
      StrCpy $updateLock $0
      ${If} $updateLock == -1
        SetErrorLevel 1
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ${If} $updateLock != ""
    System::Call 'kernel32::CloseHandle(p $updateLock)'
  ${EndIf}
!macroend
!endif
