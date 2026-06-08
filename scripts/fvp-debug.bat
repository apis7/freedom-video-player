@echo off
:: Launches the installed Freedom Video Player with the console window
:: visible. Resolves the exe via %LOCALAPPDATA% so this script can be
:: moved anywhere (desktop, USB stick, whatever) and still find FVP.
::
:: cmd.exe is FVP's parent here, so the AttachConsole hook in lib.rs
:: pipes all `eprintln!` output (every [fvp:...] log line) into this
:: window. The pause at the end keeps the window open after FVP exits
:: so you can scroll through final logs or read a panic stack trace.

title FVP (debug)
echo.
echo Launching Freedom Video Player with console output visible...
echo.
echo  - All [fvp:...] log lines stream here in real time.
echo  - This window stays open after FVP closes so you can read final logs.
echo.

set "FVP_EXE=%LOCALAPPDATA%\Freedom Video Player\fvp.exe"
if not exist "%FVP_EXE%" (
    echo ERROR: FVP not found at:
    echo   %FVP_EXE%
    echo.
    echo Install FVP first, then re-run this script.
    pause
    exit /b 1
)

"%FVP_EXE%" %*

echo.
echo ------------------------------------------------------------
echo FVP exited with code %ERRORLEVEL%. Press any key to close.
pause >nul
