@echo off
setlocal

set "ROOT=%~dp0"

start "Note Formatter AI Server" powershell.exe -NoExit -Command "Set-Location '%ROOT%'; & 'C:\Program Files\nodejs\node.exe' '%ROOT%backend\server.js'"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000

endlocal
