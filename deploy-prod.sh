#!/bin/bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/cerebro_inteligente}"

echo "==> Actualizando cerebro_inteligente en ${APP_DIR}"
cd "$APP_DIR"

git fetch origin
git reset --hard HEAD
git pull origin main

echo "==> Instalando dependencias"
npm ci

echo "==> Levantando Crawl4AI (Docker)"
if [ ! -f .llm.env ]; then
  echo "ERROR: falta .llm.env con OPENAI_API_KEY de producción"
  exit 1
fi

docker compose pull crawl4ai
docker compose up -d crawl4ai

echo "==> Verificando Crawl4AI"
curl -fsS http://127.0.0.1:11235/health >/dev/null
echo "Crawl4AI OK"

echo "==> Reiniciando cerebro con PM2"
pm2 startOrRestart ecosystem.config.js --env production --update-env
pm2 save

echo "==> Estado"
pm2 status
docker compose ps
