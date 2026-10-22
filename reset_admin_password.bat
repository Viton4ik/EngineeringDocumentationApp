@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (echo Сначала запустите start_windows.bat & pause & exit /b 1)
call .venv\Scripts\activate
python app.py --reset-admin-password
pause
