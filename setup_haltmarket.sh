#!/bin/bash
# =============================================================
# HaltMarket — Project Setup Script
# Run from: C:\Users\ejv12\ (or wherever you keep your projects)
# Usage: bash setup_haltmarket.sh
# =============================================================

set -e  # exit on any error

SRC="C:/Users/ejv12/StockHaltAnalysis"
DEST="C:/Users/ejv12/haltmarket"

echo ""
echo "================================================="
echo "  HaltMarket Project Setup"
echo "================================================="
echo ""

# -------------------------------------------------------------
# 1. Create folder structure
# -------------------------------------------------------------
echo "[1/5] Creating folder structure..."

mkdir -p "$DEST/monitor/feed"
mkdir -p "$DEST/monitor/scoring"
mkdir -p "$DEST/monitor/trading"
mkdir -p "$DEST/monitor/config"
mkdir -p "$DEST/web/src/app/predict/\[halt_id\]"
mkdir -p "$DEST/web/src/app/live-feed"
mkdir -p "$DEST/web/src/app/my-predictions"
mkdir -p "$DEST/web/src/app/leaderboard"
mkdir -p "$DEST/web/src/app/track-record"
mkdir -p "$DEST/web/src/app/pricing"
mkdir -p "$DEST/web/src/app/how-it-works"
mkdir -p "$DEST/web/src/app/verify"
mkdir -p "$DEST/web/src/app/api/predict/\[halt_id\]"
mkdir -p "$DEST/web/src/app/api/og/\[halt_id\]"
mkdir -p "$DEST/web/src/app/api/webhooks/haltpredict"
mkdir -p "$DEST/web/src/lib"
mkdir -p "$DEST/web/src/components"
mkdir -p "$DEST/web/public"
mkdir -p "$DEST/migrations"

echo "    ✅ Folders created"

# -------------------------------------------------------------
# 2. Copy monitor files (battle-tested from V1)
# -------------------------------------------------------------
echo ""
echo "[2/5] Copying monitor files from V1..."

# Core feed files — fixed and working
cp "$SRC/v2/feed/rss_reader.py"       "$DEST/monitor/feed/rss_reader.py"
echo "    ✅ rss_reader.py (RSS parsing, field[8]/field[9] split, LULD filter)"

cp "$SRC/v2/feed/halt_tracker.py"     "$DEST/monitor/feed/halt_tracker.py"
echo "    ✅ halt_tracker.py (lookup_pending_halt Supabase recovery — 98dc5ba fix)"

# Scoring engine
cp "$SRC/v2/scoring/score_predictions.py" "$DEST/monitor/scoring/score_predictions.py"
echo "    ✅ score_predictions.py (ELO scoring engine)"

cp "$SRC/v2/scoring/dna_profiles.json"    "$DEST/monitor/scoring/dna_profiles.json"
echo "    ✅ dna_profiles.json (3303 ticker DNA profiles — critical)"

# Trading bot
cp "$SRC/v2/trading/order_manager.py" "$DEST/monitor/trading/order_manager.py"
echo "    ✅ order_manager.py (Alpaca bot — update SL/TP/delay after copy)"

# Python dependencies
cp "$SRC/requirements.txt"            "$DEST/monitor/requirements.txt"
echo "    ✅ requirements.txt (supabase>=2.27.3 confirmed working)"

# Railway deploy config (try both common names)
if [ -f "$SRC/Procfile" ]; then
  cp "$SRC/Procfile" "$DEST/monitor/Procfile"
  echo "    ✅ Procfile"
fi

if [ -f "$SRC/railway.toml" ]; then
  cp "$SRC/railway.toml" "$DEST/monitor/railway.toml"
  echo "    ✅ railway.toml"
fi

if [ -f "$SRC/railway.json" ]; then
  cp "$SRC/railway.json" "$DEST/monitor/railway.json"
  echo "    ✅ railway.json"
fi

# -------------------------------------------------------------
# 3. Copy web files to adapt (not use directly)
# -------------------------------------------------------------
echo ""
echo "[3/5] Copying web reference files..."

# Service worker for push notifications — copy verbatim
if [ -f "$SRC/haltpredict-web/public/sw.js" ]; then
  cp "$SRC/haltpredict-web/public/sw.js" "$DEST/web/public/sw.js"
  echo "    ✅ sw.js (push notification service worker)"
fi

# Supabase client setup
if [ -f "$SRC/haltpredict-web/src/lib/supabase.ts" ]; then
  cp "$SRC/haltpredict-web/src/lib/supabase.ts" "$DEST/web/src/lib/supabase.ts"
  echo "    ✅ supabase.ts (client setup — update env var names)"
fi

# My Predictions — good ELO chart reference
if [ -f "$SRC/haltpredict-web/src/app/my-predictions/page.tsx" ]; then
  cp "$SRC/haltpredict-web/src/app/my-predictions/page.tsx" \
     "$DEST/web/src/app/my-predictions/page.tsx"
  echo "    ✅ my-predictions/page.tsx (ELO chart + stat cards — adapt)"
fi

# Leaderboard
if [ -f "$SRC/haltpredict-web/src/app/leaderboard/page.tsx" ]; then
  cp "$SRC/haltpredict-web/src/app/leaderboard/page.tsx" \
     "$DEST/web/src/app/leaderboard/page.tsx"
  echo "    ✅ leaderboard/page.tsx (adapt for HaltMarket)"
fi

# package.json for dependency reference
if [ -f "$SRC/haltpredict-web/package.json" ]; then
  cp "$SRC/haltpredict-web/package.json" "$DEST/web/package.json.reference"
  echo "    ✅ package.json.reference (dependency list — do not use directly)"
fi

# tailwind config
if [ -f "$SRC/haltpredict-web/tailwind.config.ts" ]; then
  cp "$SRC/haltpredict-web/tailwind.config.ts" "$DEST/web/tailwind.config.ts"
  echo "    ✅ tailwind.config.ts"
fi

if [ -f "$SRC/haltpredict-web/tailwind.config.js" ]; then
  cp "$SRC/haltpredict-web/tailwind.config.js" "$DEST/web/tailwind.config.js"
  echo "    ✅ tailwind.config.js"
fi

# -------------------------------------------------------------
# 4. Copy CLAUDE.md
# -------------------------------------------------------------
echo ""
echo "[4/5] Placing CLAUDE.md..."

# Copy from outputs if it exists there, otherwise note it
if [ -f "$DEST/../Downloads/CLAUDE.md" ]; then
  cp "$DEST/../Downloads/CLAUDE.md" "$DEST/CLAUDE.md"
  echo "    ✅ CLAUDE.md copied from Downloads"
else
  echo "    ⚠️  Place CLAUDE.md manually in $DEST/"
  echo "       (download from Claude chat outputs)"
fi

# -------------------------------------------------------------
# 5. Create stub files for Claude Code to fill
# -------------------------------------------------------------
echo ""
echo "[5/5] Creating stub files..."

# Monitor main — Claude Code writes this fresh
cat > "$DEST/monitor/main.py" << 'EOF'
# HaltMarket Monitor — V2 Clean Async Rewrite
# 
# INSTRUCTIONS FOR CLAUDE CODE:
# Read CLAUDE.md completely before editing this file.
# This is a greenfield rewrite — do NOT copy V1 monitor.py logic.
# Key requirements:
#   1. asyncio.gather() for concurrent halt processing
#   2. return_exceptions=True — never let one halt kill others  
#   3. Rebuild ALL state from Supabase on startup
#   4. pipeline_update() MUST check HTTP status_code
#   5. Always store timestamps as UTC isoformat
#   6. Only field[9] triggers resolve (not field[8])
#   7. update_cutoff() called AFTER full batch, not inside loop
#   8. ALLOWED_CODES = {'LUDP', 'LUDS', 'IPO'} only

import asyncio
import os
from datetime import datetime, timezone

# TODO: Implement per CLAUDE.md Phase 1 build order
EOF
echo "    ✅ monitor/main.py (stub — Claude Code fills this)"

# .env.example
cat > "$DEST/monitor/.env.example" << 'EOF'
# Copy to .env and fill in values
# See CLAUDE.md for full variable list

SUPABASE_URL=https://sqjdfafewyphoroaivqq.supabase.co
SUPABASE_KEY=
SUPABASE_SERVICE_ROLE_KEY=

POLYGON_API_KEY=

ALPACA_API_KEY=
ALPACA_SECRET_KEY=
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2
ENABLE_TRADING=false

TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_TOKEN_SECRET=

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=

DISCORD_WEBHOOK_URL=

HALTMARKET_API_KEY=
EOF
echo "    ✅ monitor/.env.example"

# Web .env.local.example
cat > "$DEST/web/.env.local.example" << 'EOF'
# Copy to .env.local and fill in values

NEXT_PUBLIC_SUPABASE_URL=https://sqjdfafewyphoroaivqq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=

SUPABASE_SERVICE_ROLE_KEY=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

HALTMARKET_API_KEY=
CRON_SECRET=

NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
EOF
echo "    ✅ web/.env.local.example"

# .gitignore
cat > "$DEST/.gitignore" << 'EOF'
# Python
__pycache__/
*.py[cod]
*.so
.env
venv/
.venv/

# Next.js
web/.next/
web/node_modules/
web/.env.local
web/.env.production

# Monitor
monitor/.env
monitor/haltmarket.db
monitor/monitor_output.log

# OS
.DS_Store
Thumbs.db
EOF
echo "    ✅ .gitignore"

# README
cat > "$DEST/README.md" << 'EOF'
# HaltMarket

CFTC-preliminary-approved NASDAQ halt prediction exchange.

## Quick Start

See CLAUDE.md for full build instructions.

### Monitor (Railway)
```bash
cd monitor
pip install -r requirements.txt
python main.py
```

### Web (Vercel)
```bash
cd web
npm install
npm run dev
```

## Supabase
Project: sqjdfafewyphoroaivqq
URL: https://sqjdfafewyphoroaivqq.supabase.co

## Domains
haltmarket.com
EOF
echo "    ✅ README.md"

# -------------------------------------------------------------
# Done
# -------------------------------------------------------------
echo ""
echo "================================================="
echo "  Setup Complete!"
echo "================================================="
echo ""
echo "  Structure created at: $DEST"
echo ""
echo "  Next steps:"
echo "  1. Place CLAUDE.md in $DEST/ if not already there"
echo "  2. Update MCP configs with haltmarket service role key:"
echo "     Claude Desktop: C:/Users/ejv12/AppData/Roaming/Claude/claude_desktop_config.json"
echo "     Claude Code:    C:/Users/ejv12/.claude/settings.json"
echo "  3. Restart Claude Desktop"
echo "  4. Open new Claude Code terminal in $DEST/"
echo "  5. First message: 'Read CLAUDE.md and start Phase 1'"
echo ""
echo "  Files copied from V1 (use as-is):"
echo "    monitor/feed/rss_reader.py"
echo "    monitor/feed/halt_tracker.py"
echo "    monitor/scoring/score_predictions.py"
echo "    monitor/scoring/dna_profiles.json"
echo "    monitor/trading/order_manager.py  ← update SL/TP/delay"
echo "    monitor/requirements.txt"
echo ""
echo "  Files to adapt (not use directly):"
echo "    web/src/app/my-predictions/page.tsx"
echo "    web/src/app/leaderboard/page.tsx"
echo "    web/src/lib/supabase.ts"
echo "    web/public/sw.js"
echo ""
echo "  DO NOT copy: monitor.py, dashboard, PredictionGate"
echo ""
