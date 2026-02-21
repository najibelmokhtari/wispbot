#!/bin/bash

# --lines 200 ensures we see enough history to catch the full QR code
# --force ensures we see logs even if the process is effectively 'streaming'
pm2 logs "whatsapp-bot" --lines 200