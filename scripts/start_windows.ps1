# Start FinAlly in Docker (Windows PowerShell). Safe to run repeatedly.
# Usage: .\scripts\start_windows.ps1 [-Build] [-NoOpen]
param(
    [switch]$Build,
    [switch]$NoOpen
)

# 'Continue' so stderr from native docker calls (redirected below) is not a terminating
# error in Windows PowerShell 5.1; failures are detected via $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

$Image = 'finally'
$Container = 'finally'
$Volume = 'finally-data'
$Port = if ($env:PORT) { $env:PORT } else { '8000' }
$Url = "http://localhost:$Port"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Test-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs *> $null
    return ($LASTEXITCODE -eq 0)
}

if (-not (Test-Docker @('info'))) {
    Write-Error 'Docker is not running. Start Docker Desktop and try again.'
    exit 1
}

# Environment file: create from the example if missing
if (-not (Test-Path '.env')) {
    if (Test-Path '.env.example') {
        Write-Warning '.env not found; creating it from .env.example. Add your OPENROUTER_API_KEY for AI chat.'
        Copy-Item '.env.example' '.env'
    } else {
        Write-Warning '.env not found; running without it (AI chat will not work).'
    }
}
$EnvArgs = @()
if (Test-Path '.env') { $EnvArgs = @('--env-file', '.env') }

# Build the image if missing or requested
if ($Build -or -not (Test-Docker @('image', 'inspect', $Image))) {
    Write-Host "Building Docker image '$Image'..."
    & docker build -t $Image .
    if ($LASTEXITCODE -ne 0) { Write-Error 'Docker build failed.'; exit 1 }
}

# Remove any existing container (running or stopped)
if (Test-Docker @('container', 'inspect', $Container)) {
    Write-Host "Removing existing container '$Container'..."
    & docker rm -f $Container *> $null
}

Write-Host "Starting container '$Container'..."
$RunArgs = @('run', '-d', '--name', $Container, '-v', "${Volume}:/app/db", '-p', "${Port}:8000") + $EnvArgs + @($Image)
& docker @RunArgs | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'Failed to start container.'; exit 1 }

# Wait for the health endpoint (up to ~60s)
Write-Host -NoNewline 'Waiting for FinAlly to become healthy'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 1
}
Write-Host ''
if (-not $ready) { Write-Warning "Health check did not pass yet. Check logs with: docker logs $Container" }

Write-Host "FinAlly is running at $Url"
Write-Host 'Stop it with: .\scripts\stop_windows.ps1'

if (-not $NoOpen) { Start-Process $Url }
