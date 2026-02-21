#!/bin/bash

# Ensure dependencies are installed
npm install

# 1. Delete any existing process to avoid conflicts
pm2 delete "whatsapp-bot" 2>/dev/null || true

# 2. Start via ecosystem config if available, otherwise start directly
if [ -f ecosystem.config.js ]; then
    pm2 start ecosystem.config.js --env development
else
    pm2 start src/bot.js --name whatsapp-bot
fi

# Save the PM2 list
pm2 save

echo "Bot started successfully!"
echo "Run ./show_logs.sh immediately to scan the QR code."