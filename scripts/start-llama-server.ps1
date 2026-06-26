$llamaDir  = "$PSScriptRoot\..\data\llama-hip"
$modelPath = "$llamaDir\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
$port      = 11435

if (-not (Test-Path $modelPath)) {
  Write-Host "Model not found: $modelPath" -ForegroundColor Red
  exit 1
}

Write-Host "Starting llama-server on port $port (auto-fit) ..." -ForegroundColor Cyan
Write-Host "  Model: $modelPath"
Write-Host "  GPU: auto-fit (VRAM に入る分だけ自動で載せる)"
Write-Host ""

& "$llamaDir\llama-server.exe" `
  -m "$modelPath" `
  --no-mmap `
  --reasoning off `
  -c 4096 `
  --port $port
