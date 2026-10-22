@echo off
chcp 65001 >nul
title GASTRANS Documentation Server
cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv
  if errorlevel 1 (echo Не удалось создать виртуальное окружение. Установите Python 3.10+ & pause & exit /b 1)
)
call .venv\Scripts\activate
python -m pip install --upgrade pip >nul
pip install -r requirements.txt
set DOC_ROOT=C:\Documentation
set DOC_META_DIR=C:\Documentation_ext
set PORT=8080
rem Имя общей папки, которая указывает на DOC_ROOT (общий доступ "только чтение" для сотрудников):
rem Свойства папки C:\Documentation -> Доступ -> Расширенная настройка -> Имя ресурса "Documentation".
rem Сервер в сетевом пути берётся из адреса, по которому сотрудник открыл каталог: по IP - \\10.200.15.106\Documentation,
rem по имени - \\ИМЯ-ПК\Documentation. Поэтому путь работает и через Wi-Fi, и после переезда сервера.
set DOC_SHARE=Documentation
rem Разделы, где название документа = имя файла, без чтения первой страницы (несколько через ;):
set NAME_FROM_FILENAME=Check lists
rem Лимит одной заявки в МБ и разрешённые расширения (через пробел). Без UPLOAD_EXTS действует список по умолчанию.
set UPLOAD_MAX_MB=500
rem set UPLOAD_EXTS=pdf docx xlsx dwg zip exe
rem Одобрять заявки можно с любого ПК. Чтобы разрешить одобрение только на самом сервере, уберите rem:
rem set APPROVE_ONLY_ON_SERVER=1
rem Если LibreOffice или ffmpeg установлены не в стандартную папку:
rem set SOFFICE=D:\LibreOffice\program\soffice.exe
rem set FFMPEG=D:\ffmpeg\bin\ffmpeg.exe
echo.
echo Каталог документации на этом ПК: http://127.0.0.1:%PORT%
echo Для сотрудников в локальной сети:  http://%COMPUTERNAME%:%PORT%
echo Админ-панель (логин admin):       http://%COMPUTERNAME%:%PORT%/admin
echo Разрешите TCP %PORT% во входящих правилах Windows Firewall для Private/Domain.
echo.
python app.py
pause
