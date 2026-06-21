# Multi-Session WhatsApp Bot Guide

## Overview

Your WhatsApp bot now supports multiple simultaneous sessions, allowing you to manage multiple WhatsApp accounts from a single bot instance.

## Configuration

### Session Config File (`sessions.json`)

Located in the project root, this file controls which sessions are active.

```json
{
  "defaultSession": "client1",
  "sessions": {
    "client1": {
      "name": "Client 1 Bot",
      "enabled": true
    },
    "client2": {
      "name": "Client 2 Bot",
      "enabled": true
    },
    "client3": {
      "name": "Test Session",
      "enabled": false
    }
  }
}
```

### Session Options

- **`defaultSession`**: The session used when no session parameter is provided
- **`sessions`**: Object containing all session configurations
  - **`name`**: Display name for the session
  - **`enabled`**: Whether to start this session on bot startup

### Adding a New Session

1. Edit `sessions.json`:
```json
{
  "defaultSession": "client1",
  "sessions": {
    "client1": { "name": "Client 1", "enabled": true },
    "new_client": { "name": "New Client", "enabled": true }
  }
}
```

2. Restart the bot
3. New session will connect automatically

### Removing a Session

1. Edit `sessions.json` to remove or disable the session:
```json
{
  "sessions": {
    "client1": { "name": "Client 1", "enabled": true },
    "old_client": { "name": "Old Client", "enabled": false }
  }
}
```

2. Optional: Delete the auth folder: `rm -rf src/auth_info/old_client`

## Session Storage

Each session has its own authentication folder:

```
src/auth_info/
├── client1/
│   ├── creds.json
│   └── ...
├── client2/
│   ├── creds.json
│   └── ...
└── default/
    ├── creds.json
    └── ...
```

## API Usage

### QR Code Display

**Default session:**
```
http://localhost:3000/qr
```

**Specific session:**
```
http://localhost:3000/qr?session=client2
```

### Health Check

**All sessions:**
```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "defaultSession": "client1",
  "sessions": {
    "client1": {
      "connected": true,
      "hasQR": false
    },
    "client2": {
      "connected": false,
      "hasQR": true
    }
  },
  "totalSessions": 2
}
```

**Specific session:**
```bash
curl http://localhost:3000/health?session=client2
```

Response:
```json
{
  "status": "ok",
  "session": "client2",
  "connected": false,
  "exists": true,
  "hasQR": true
}
```

### Send Message

**Default session:**
```bash
curl -X POST http://localhost:3000/api/send-text \
  -H "Content-Type: application/json" \
  -d '{"to": "6281234567890@s.whatsapp.net", "message": "Hello!"}'
```

**Specific session (query parameter):**
```bash
curl -X POST "http://localhost:3000/api/send-text?session=client2" \
  -H "Content-Type: application/json" \
  -d '{"to": "6281234567890@s.whatsapp.net", "message": "Hello!"}'
```

**Specific session (body parameter):**
```bash
curl -X POST http://localhost:3000/api/send-text \
  -H "Content-Type: application/json" \
  -d '{
    "to": "6281234567890@s.whatsapp.net",
    "message": "Hello!",
    "session": "client2"
  }'
```

### Get Groups

```bash
# Default session
curl http://localhost:3000/api/groups

# Specific session
curl http://localhost:3000/api/groups?session=client2
```

Response:
```json
{
  "session": "client1",
  "groups": [
    {
      "id": "6281234567890@g.us",
      "name": "Family Group",
      "participants": 5
    }
  ]
}
```

## WebSocket Usage

### Connection URL

**Default session:**
```
ws://localhost:3001
```

**Specific session:**
```
ws://localhost:3001?session=client2
```

**Multiple sessions:**
```
ws://localhost:3001?session=client1,client2,client3
```

### Message Format

All incoming messages now include session information:

```json
{
  "event": "message",
  "session": "client1",
  "data": {
    "from": "6281234567890@s.whatsapp.net",
    "isGroupMsg": false,
    "fromMe": false,
    "body": "Hello!",
    "author": "6281234567890",
    "id": "3EB0...",
    "sender": {
      "lid": "6281234567890@lid",
      "phoneNumber": "6281234567890",
      "name": "John Doe",
      "pushName": "John"
    },
    "timestamp": 1234567890
  }
}
```

### Python Client Example

```python
import websocket
import json

# Connect to specific session
ws = websocket.WebSocket()
ws.connect("ws://localhost:3001?session=client1")

# Or connect to multiple sessions
ws.connect("ws://localhost:3001?session=client1,client2")

# Handle messages
def on_message(ws, message):
    data = json.loads(message)
    print(f"Session: {data['session']}")
    print(f"Body: {data['data']['body']}")

    # Only process messages from specific session
    if data['session'] == 'client1':
        # Handle client1 messages
        pass
```

## Session Management

### View All Sessions
```bash
curl http://localhost:3000/health
```

### View QR for Specific Session
```
http://localhost:3000/qr?session=client_name
```

### Restart a Session
1. Edit `sessions.json` to disable the session
2. Restart the bot
3. Edit `sessions.json` to re-enable the session
4. Restart the bot

Or simply delete the auth folder and restart:
```bash
rm -rf src/auth_info/client_name
```

## Backward Compatibility

The API is **backward compatible** with existing single-session implementations:

- Existing API calls without session parameter use the default session
- WebSocket connections without `?session=` receive default session messages
- Old Python clients continue to work (they'll only receive default session messages)

To upgrade to multi-session:
1. Add `?session=xyz` to API calls
2. Add `?session=xyz` to WebSocket connections
3. Update message handlers to check the `session` field

## Troubleshooting

### Session Not Connecting
- Check the session is enabled in `sessions.json`
- Verify auth folder exists: `ls src/auth_info/session_name/`
- Check logs: `Session session_name connecting to WhatsApp...`

### QR Code Not Showing
- Visit: `http://localhost:3000/qr?session=session_name`
- Check health status: `http://localhost:3000/health?session=session_name`

### Messages Not Received
- Verify WebSocket connection includes session parameter
- Check session is connected in health endpoint
- Verify correct session ID in WebSocket URL

### Conflicting Session Names
- Session IDs must be unique
- Session IDs are case-sensitive

## Migration from Single Session

If you're upgrading from a single-session bot:

1. Your existing auth folder is now the "default" session
2. Create `sessions.json` (already created for you)
3. Test with default session first:
   ```bash
   curl http://localhost:3000/health
   ```
4. Add new sessions as needed
5. Update your clients to use session parameters

## Examples

### Example 1: Three Client Setup

`sessions.json`:
```json
{
  "defaultSession": "client1",
  "sessions": {
    "client1": {
      "name": "Main Business Account",
      "enabled": true
    },
    "client2": {
      "name": "Support Account",
      "enabled": true
    },
    "client3": {
      "name": "Personal Account",
      "enabled": true
    }
  }
}
```

**Usage:**
```bash
# Client 1 QR
http://localhost:3000/qr?session=client1

# Client 2 QR
http://localhost:3000/qr?session=client2

# Client 3 QR
http://localhost:3000/qr?session=client3
```

### Example 2: Development and Production

`sessions.json`:
```json
{
  "defaultSession": "production",
  "sessions": {
    "production": {
      "name": "Production Bot",
      "enabled": true
    },
    "dev": {
      "name": "Development Bot",
      "enabled": true
    }
  }
}
```

**Development workflow:**
```bash
# Use dev session for testing
curl -X POST "http://localhost:3000/api/send-text?session=dev" \
  -H "Content-Type: application/json" \
  -d '{"to": "...", "message": "Test message"}'

# Use production session for real messages
curl -X POST "http://localhost:3000/api/send-text" \
  -H "Content-Type: application/json" \
  -d '{"to": "...", "message": "Real message"}'
```

## Security Notes

1. **Session Isolation**: Each session has separate authentication and cannot access other sessions
2. **WebSocket Subscriptions**: Clients only receive messages from sessions they subscribe to
3. **API Access**: Consider adding authentication for production use
4. **Session IDs**: Don't expose sensitive information in session names (visible in logs and URLs)

## Need Help?

Check the bot logs for detailed session information:
- Session connection status
- QR code generation
- Message routing
- Error messages
