Set-Location "C:\NodeJS\KawaiiLive"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null
$env:PYTHONUTF8 = "1"
$env:RADIO_LOG_LLM = "1"
& "C:\Program Files\nodejs\node.exe" "app/server.js"
