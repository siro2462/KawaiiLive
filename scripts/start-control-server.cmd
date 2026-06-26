@echo off
cd /d C:\NodeJS\KawaiiLive
chcp 65001 > nul
set NODE_OPTIONS=--no-warnings
set PYTHONUTF8=1
set RADIO_LOG_LLM=1
"C:\Program Files\nodejs\node.exe" app\server.js
