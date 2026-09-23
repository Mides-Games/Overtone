@echo off
rem Overtone launcher: double-click to open the app (web shell + GUI).
rem A file dropped onto this icon opens straight into analysis.
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\pythonw.exe"
if not exist "%PY%" (
    echo No se encuentra el interprete: %PY%
    echo Instala el entorno del proyecto primero: python -m venv .venv
    pause
    exit /b 1
)
start "Overtone" "%PY%" "%HERE%overtone_web.py" %*
