#!/usr/bin/env node
/**
 * CLI Script: qr.js
 * Watches the bot logs for the QR code and displays it.
 * Useful when you don't want to scroll through all logs.
 */

const { spawn } = require('child_process');

console.log('🔍 Waiting for QR Code from logs...');
console.log('Ensure the bot is running (pm2 start ecosystem.config.js)');
console.log('Press Ctrl+C to exit');
console.log('-'.repeat(50));

const os = require('os');
const path = require('path');
const pm2LogPath = path.join(os.homedir(), '.pm2', 'logs', 'whatsapp-bot-out.log');
const tail = spawn('tail', ['-f', '-n', '200', pm2LogPath]);

tail.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        // Pass through lines that look like QR code parts or the startup messages
        if (line.includes('QR CODE READY') ||
            line.includes('Scan this QR code') ||
            line.includes('▄') || // QR code block characters
            line.includes('▀')) {
            console.log(line);
        }
    }
});

tail.stderr.on('data', (data) => {
    // console.error(`stderr: ${data}`);
});

tail.on('close', (code) => {
    console.log(`child process exited with code ${code}`);
});
