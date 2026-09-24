#!/usr/bin/env bash
# Run this once on a fresh Oracle Cloud Always Free Ubuntu instance
# to provision Docker + Docker Compose, then pull and start the pipeline.
#
# Usage:
#   chmod +x setup-oracle-cloud.sh
#   ./setup-oracle-cloud.sh <your-git-repo-url>

set -euo pipefail

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  echo "Usage: ./setup-oracle-cloud.sh <git-repo-url>"
  exit 1
fi

echo "==> Updating system packages"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "==> Installing Docker"
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker "$USER"
rm get-docker.sh

echo "==> Installing Docker Compose plugin"
sudo apt-get install -y docker-compose-plugin

echo "==> Opening firewall for HTTP (80) and Traefik dashboard (8080)"
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true

echo "==> Cloning project repo"
git clone "$REPO_URL" student-portal
cd student-portal

echo "==> Setting up environment file"
cp .env.example .env
echo "!! Edit .env with real credentials before going further !!"

echo "==> Bringing up the pipeline"
sudo docker compose up -d --build

echo "==> Done. Check status with: sudo docker compose ps"
echo "==> Test the pipeline with:  curl http://localhost/health"
echo ""
echo "NOTE: log out and back in for the docker group membership to apply"
echo "      without needing 'sudo' on future commands."
