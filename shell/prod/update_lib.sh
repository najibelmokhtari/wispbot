#!/bin/bash

echo "🔄 Stopping the bot to perform safe update..."
pm2 stop "whatsapp-bot"

echo "⬇️  Fetching the latest version of whatsapp-web.js from GitHub..."
# This specific command forces npm to re-download the package from the remote branch,
# bypassing the cache/lockfile for this specific dependency.
npm install github:pedroslopez/whatsapp-web.js#main

echo "📦 Ensuring all other dependencies are installed..."
PUPPETEER_SKIP_DOWNLOAD=true npm install

echo "🚀 Restarting the bot..."
# Using reload to refresh the process with the new code
pm2 reload ecosystem.config.js --env development

echo "✅ Update complete! Tailing logs to ensure successful startup..."
# Show logs immediately to verify it connects
pm2 logs "whatsapp-bot" --lines 50