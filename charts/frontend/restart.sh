#!/bin/bash
# Restart the dev servers

# Kill any existing processes on ports
lsof -ti:5053 -ti:5054 | xargs -r kill -9 2>/dev/null

# Kill any existing servers
pkill -f "vite" 2>/dev/null
pkill -f "tsx.*server" 2>/dev/null

cd "$(dirname "$0")"

# Start API server in background (port 5054)
npm run server &

# Start Vite dev server (port 5053)
npm run dev
