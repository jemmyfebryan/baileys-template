.PHONY: help start stop restart logs kill install setup dev prod

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup      - Install dependencies and create necessary directories"
	@echo "  make start      - Start the bot with PM2"
	@echo "  make stop       - Stop the bot"
	@echo "  make restart    - Restart the bot"
	@echo "  make logs       - View bot logs"
	@echo "  make kill       - Kill and remove bot from PM2"
	@echo "  make dev        - Run in development mode with nodemon"
	@echo "  make prod       - Run in production mode with PM2"
	@echo "  make install    - Install dependencies"
	@echo "  make status     - Check bot status"
	@echo "  make monitor    - Open PM2 monitor"

# Install dependencies and setup
install:
	npm install

setup: install
	@echo "Creating necessary directories..."
	@mkdir -p src/auth_info
	@mkdir -p logs
	@cp -n .env.example .env 2>/dev/null || true
	@echo "Setup complete! Configure your environment variables in .env file"

# Start the bot with PM2
start:
	@pm2 start ecosystem.config.js
	@pm2 save

# Stop the bot
stop:
	@pm2 stop baileys-bot

# Restart the bot
restart:
	@pm2 restart baileys-bot

# View logs
logs:
	@pm2 logs baileys-bot

# Kill and remove from PM2
kill:
	@pm2 delete baileys-bot

# Development mode (requires nodemon)
dev:
	@echo "Running in development mode..."
	@node src/index.js

# Production mode
prod: start

# Check status
status:
	@pm2 status

# Open PM2 monitor
monitor:
	@pm2 monit

# Rebuild (install and restart)
rebuild: install restart
