#!/bin/bash

echo "Pulling latest changes from git..."
git pull

echo "Installing dependencies (in case package.json changed)..."
PUPPETEER_SKIP_DOWNLOAD=true npm install

echo "Update complete!"
echo "If code changes were pulled, remember to restart: ./restart_bot.sh"