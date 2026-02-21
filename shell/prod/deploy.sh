#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Execute scripts from the same directory
"$SCRIPT_DIR/git_pull.sh"
"$SCRIPT_DIR/restart_bot.sh"
"$SCRIPT_DIR/show_logs.sh"