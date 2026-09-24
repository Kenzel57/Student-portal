# Run this in PowerShell from the project folder:
#   .\diagnose-socket.ps1
#
# It isolates WHICH layer of Docker socket access is broken, so you fix
# the right thing instead of guessing.

Write-Host "`n=== 1. Is the Docker CLI talking to the daemon? ===" -ForegroundColor Cyan
docker version --format "Client: {{.Client.Version}}  Server: {{.Server.Version}}"

Write-Host "`n=== 2. Which backend is Docker Desktop using? ===" -ForegroundColor Cyan
docker info --format "OS: {{.OperatingSystem}}  |  Driver: {{.Driver}}"
Write-Host "(Should say 'Docker Desktop' and ideally WSL2, not Hyper-V)"

Write-Host "`n=== 3. THE KEY TEST: can a container reach the socket? ===" -ForegroundColor Cyan
Write-Host "Running a throwaway container that mounts the socket and calls the API..."
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock `
  curlimages/curl:latest `
  -s --unix-socket /var/run/docker.sock http://localhost/version

Write-Host "`n"
Write-Host "HOW TO READ TEST 3:" -ForegroundColor Yellow
Write-Host "  - JSON with version info  -> socket access WORKS. Traefik should work;"
Write-Host "    if it still doesn't, the problem is labels/network, not the socket."
Write-Host "  - Empty output or an error -> socket access is BLOCKED. Fix it by"
Write-Host "    enabling Docker Desktop > Settings > Advanced >"
Write-Host "    'Allow the default Docker socket to be used', then Apply & Restart."
Write-Host "                                                                       "