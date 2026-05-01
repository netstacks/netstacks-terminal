; Kill running NetStacks processes so the installer can overwrite locked files.
; Without this, NSIS shows "Error opening file for writing: netstacks-agent.exe"
; when an existing install (or sidecar) is still running during upgrade.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM netstacks.exe /T'
  nsExec::Exec 'taskkill /F /IM netstacks-agent.exe /T'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM netstacks.exe /T'
  nsExec::Exec 'taskkill /F /IM netstacks-agent.exe /T'
  Sleep 500
!macroend
