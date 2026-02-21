#!/bin/bash

# Reloads the process using the settings in ecosystem.config.js
pm2 reload ecosystem.config.js --env development

echo "Bot restarted and configuration reloaded."