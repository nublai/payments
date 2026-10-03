#!/bin/bash

pkill -9 -f "anvil" 2>/dev/null && echo "Killed anvil instances" || echo "No anvil instances running"
pkill -9 -f "wrangler" 2>/dev/null && echo "Killed wrangler instances" || echo "No wrangler instances running"
lsof -ti:8787 | xargs kill -9 2>/dev/null && echo "Killed process on port 8787" || true
lsof -ti:8545 | xargs kill -9 2>/dev/null && echo "Killed process on port 8545" || true
lsof -ti:8546 | xargs kill -9 2>/dev/null && echo "Killed process on port 8546" || true
