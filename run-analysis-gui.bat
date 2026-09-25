@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 tools\analysis_gui.py
  exit /b %errorlevel%
)

python tools\analysis_gui.py
