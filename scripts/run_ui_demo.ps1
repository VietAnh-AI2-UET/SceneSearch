param([ValidateSet('api', 'worker')][string]$Role = 'api', [int]$Port = 8000)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$demoPython = Join-Path (Get-Location) '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $demoPython)) { throw 'Chưa có .venv. Hãy cài môi trường Python theo README.' }
$env:PATH = (Join-Path (Get-Location) '.venv\Scripts') + ';' + $env:PATH
foreach ($demoTool in @('ffmpeg', 'ffprobe')) {
    if (-not (Get-Command $demoTool -ErrorAction SilentlyContinue)) { throw "Không tìm thấy $demoTool trong PATH." }
}
$env:INDEXING_CONFIG = 'configs/indexing/local.yaml'
$env:RETRIEVAL_CONFIG = 'configs/retrieval/local.yaml'
if ($Role -eq 'api') {
    & $demoPython -m uvicorn src.main:app --host 127.0.0.1 --port $Port
} else {
    & $demoPython -m src.indexing.workflows.worker --indexing-config $env:INDEXING_CONFIG --retrieval-config $env:RETRIEVAL_CONFIG
}
