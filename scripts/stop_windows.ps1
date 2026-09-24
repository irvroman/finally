# Stop FinAlly (Windows PowerShell). Keeps the finally-data volume so data persists.
$Container = 'finally'

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Docker is not running; nothing to stop.'
    exit 0
}

& docker container inspect $Container *> $null
if ($LASTEXITCODE -eq 0) {
    & docker rm -f $Container *> $null
    Write-Host "Stopped and removed container '$Container'. Data volume 'finally-data' kept."
} else {
    Write-Host "Container '$Container' is not running."
}
exit 0
