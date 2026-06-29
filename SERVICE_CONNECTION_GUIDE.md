# Service WebSocket Connection Guide

## Problem

Your service was implemented before the multi-session feature was added. It connects to the WebSocket without specifying which session to use, causing message routing issues.

## Solution

### WebSocket Connection URL

**OLD (incorrect):**
```
ws://your-baileys-host:3001
```

**NEW (correct for "watson" session):**
```
ws://your-baileys-host:3001?session=watson
```

### Connection Examples

**Python (websocket-client):**
```python
import websocket
import json

# OLD
# ws.connect("ws://your-baileys-host:3001")

# NEW - specify session
ws = websocket.WebSocket()
ws.connect("ws://your-baileys-host:3001?session=watson")

# Handle incoming messages
def on_message(ws, message):
    data = json.loads(message)
    
    # Messages now include session info
    session = data.get('session', 'watson')
    event = data.get('event')
    msg_data = data.get('data', {})
    
    if event == 'message':
        print(f"From: {msg_data.get('from')}")
        print(f"Body: {msg_data.get('body')}")
        print(f"Sender Phone: {msg_data.get('sender', {}).get('phoneNumber')}")
```

**JavaScript/Node.js (ws):**
```javascript
const WebSocket = require('ws');

// OLD
// const ws = new WebSocket('ws://your-baileys-host:3001');

// NEW - specify session
const ws = new WebSocket('ws://your-baileys-host:3001?session=watson');

ws.on('message', (data) => {
    const message = JSON.parse(data);

    // Messages now include session info
    const { session, event, data: msgData } = message;

    if (event === 'message') {
        console.log('From:', msgData.from);
        console.log('Body:', msgData.body);
        console.log('Sender Phone:', msgData.sender?.phoneNumber);
    }
});
```

**Go (gorilla/websocket):**
```go
// OLD
// url := "ws://your-baileys-host:3001"

// NEW - specify session
url := "ws://your-baileys-host:3001?session=watson"
ws, _, err := websocket.DefaultDialer.Dial(url, nil)
```

**cURL test:**
```bash
# Test connection to watson session
wscat -c "ws://your-baileys-host:3001?session=watson"
```

## Message Format Change

All incoming messages now include a `session` field:

```json
{
  "event": "message",
  "session": "watson",
  "data": {
    "from": "120363426253174639@g.us",
    "isGroupMsg": true,
    "fromMe": false,
    "body": "Hello group!",
    "author": "6281234567890",
    "id": "3EB0...",
    "sender": {
      "lid": "6281234567890@lid",
      "phoneNumber": "6281234567890",
      "name": "John Doe",
      "pushName": "John"
    },
    "timestamp": 1782470867
  }
}
```

### Key Fields
- `session`: Always "watson" for your connection
- `data.isGroupMsg`: `true` if message is from a group
- `data.from`: Group JID or contact JID
- `data.sender.phoneNumber`: Phone number when available
- `data.body`: Message text content

## Available Sessions

Current sessions configured:
- **watson**: ✅ Enabled (use this one)
- **hana**: ❌ Disabled
- **default**: ❌ Disabled

## Health Check

Verify session status:
```bash
curl http://your-baileys-host:3000/health?session=watson
```

Expected response:
```json
{
  "status": "ok",
  "session": "watson",
  "connected": true,
  "exists": true,
  "hasQR": false,
  "clients": 1
}
```

## Quick Migration Checklist

- [ ] Update WebSocket URL to include `?session=watson`
- [ ] Test connection with wscat or similar tool
- [ ] Verify receiving messages from "watson" session
- [ ] (Optional) Update message handler to check `session` field
- [ ] Deploy and verify in production

## Support

If you still experience issues after updating the connection URL:
1. Check session is connected: `curl http://your-baileys-host:3000/health?session=watson`
2. Check Baileys logs for errors
3. Verify session "watson" is enabled in `sessions.json`
