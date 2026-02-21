#!/bin/bash

# Download Chrome for Testing v130 to the data drive.
# Puppeteer 23.6.0 is built for Chrome ~130. The system Chrome 142 has a V8
# breaking change (instanceof throws on undefined prototype) that crashes
# WhatsApp Web's internal module system, preventing QR code generation.

INSTALL_PATH="${CHROME_INSTALL_PATH:-./data/chrome-for-testing}"
CHROME_VERSION="130.0.6723.58"

echo "Installing Chrome for Testing ${CHROME_VERSION} to ${INSTALL_PATH}..."

# Create install directory if it doesn't exist
mkdir -p "${INSTALL_PATH}"

# Use @puppeteer/browsers to download the exact Chrome version
npx @puppeteer/browsers install "chrome@${CHROME_VERSION}" --path "${INSTALL_PATH}"

CHROME_BIN="${INSTALL_PATH}/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome"

if [ -f "${CHROME_BIN}" ]; then
    echo ""
    echo "Chrome for Testing installed successfully!"
    echo "Binary: ${CHROME_BIN}"
    echo ""
    echo "Version check:"
    "${CHROME_BIN}" --version
    echo ""
    echo "bot.js will automatically detect and use this Chrome binary."
    echo "Restart the bot: ./restart_bot.sh"
else
    echo ""
    echo "ERROR: Chrome binary not found at expected path: ${CHROME_BIN}"
    echo "Check the output above for errors."
    echo ""
    echo "Listing what was installed:"
    find "${INSTALL_PATH}" -name "chrome" -type f 2>/dev/null
    exit 1
fi
