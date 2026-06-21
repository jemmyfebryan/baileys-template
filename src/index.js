const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const logger = pino({ level: 'info' });
const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Session configuration
let sessionConfig = {
  defaultSession: 'default',
  sessions: {}
};

// Load session config
const configPath = path.join(__dirname, '..', 'sessions.json');
if (fs.existsSync(configPath)) {
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    sessionConfig = JSON.parse(configData);
    logger.info(`Loaded session config with ${Object.keys(sessionConfig.sessions).length} sessions`);
  } catch (error) {
    logger.error('Error loading sessions.json:', error);
    logger.info('Using default session configuration');
  }
} else {
  logger.warn('sessions.json not found, using default configuration');
  sessionConfig = {
    defaultSession: 'default',
    sessions: {
      default: {
        name: 'Default Session',
        enabled: true
      }
    }
  };
}

// Session management
class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> { sock, isConnected, latestQR, ... }
    this.wsClients = new Map(); // ws -> { subscribedSessions: Set<string> }
  }

  // Get session by ID, returns default if not found
  getSession(sessionId) {
    return this.sessions.get(sessionId || sessionConfig.defaultSession);
  }

  // Get or create default session
  getDefaultSession() {
    return this.getSession(sessionConfig.defaultSession);
  }

  // Add or update a session
  setSession(sessionId, sessionData) {
    this.sessions.set(sessionId, sessionData);
  }

  // Get all active session IDs
  getActiveSessionIds() {
    return Array.from(this.sessions.keys());
  }

  // Check if session exists
  hasSession(sessionId) {
    return this.sessions.has(sessionId || sessionConfig.defaultSession);
  }

  // Get session status object
  getSessionStatus(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { connected: false, exists: false };
    }
    return {
      connected: session.isConnected,
      exists: true,
      hasQR: !!session.latestQR
    };
  }

  // Get all sessions status
  getAllSessionsStatus() {
    const status = {};
    for (const [sessionId, sessionData] of this.sessions) {
      status[sessionId] = {
        connected: sessionData.isConnected,
        hasQR: !!sessionData.latestQR,
        config: sessionConfig.sessions[sessionId] || { name: sessionId, enabled: true }
      };
    }
    return status;
  }
}

const sessionManager = new SessionManager();

// Group metadata cache - session-specific
const groupMetadataCache = new Map(); // sessionId -> Map<groupJid, {data, timestamp}>

// Phone number cache - session-specific
const phoneNumberCache = new Map(); // sessionId -> Map<LID/ID, PhoneNumber>

// Cache TTL
const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Auth state storage - session-specific
function getAuthInfoPath(sessionId) {
  const sessionAuthPath = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(sessionAuthPath)) {
    fs.mkdirSync(sessionAuthPath, { recursive: true });
  }
  return sessionAuthPath;
}

// Initialize caches for a session
function initSessionCaches(sessionId) {
  if (!groupMetadataCache.has(sessionId)) {
    groupMetadataCache.set(sessionId, new Map());
  }
  if (!phoneNumberCache.has(sessionId)) {
    phoneNumberCache.set(sessionId, new Map());
  }
}

// WebSocket Server for pushing events to Python app
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  // Parse session parameter from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionParam = url.searchParams.get('session') || sessionConfig.defaultSession;

  // Split by comma to support multiple sessions
  const subscribedSessions = new Set(sessionParam.split(',').map(s => s.trim()));

  logger.info(`New Python client connected, subscribed to sessions: [${Array.from(subscribedSessions).join(', ')}]`);

  // Store client with their subscriptions
  wsClients.set(ws, {
    subscribedSessions
  });

  ws.on('close', () => {
    logger.info('Python client disconnected');
    wsClients.delete(ws);
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });
});

// Broadcast message to connected Python clients based on session subscriptions
function broadcastToClients(sessionId, data) {
  const message = JSON.stringify(data);
  wsClients.forEach((clientData, ws) => {
    if (ws.readyState === 1) { // OPEN
      // Only send to clients subscribed to this session
      if (clientData.subscribedSessions.has(sessionId)) {
        ws.send(message);
      }
    }
  });
}

// Get group metadata with caching (session-specific)
async function getGroupMetadata(sessionId, groupJid, sock) {
  try {
    const sessionCache = groupMetadataCache.get(sessionId);
    if (!sessionCache) return null;

    // Check cache first
    const cached = sessionCache.get(groupJid);
    if (cached && (Date.now() - cached.timestamp) < GROUP_CACHE_TTL) {
      return cached.data;
    }

    // Fetch fresh metadata
    logger.info(`[Session ${sessionId}] Fetching group metadata for ${groupJid}`);
    const metadata = await sock.groupMetadata(groupJid);

    // Cache it
    sessionCache.set(groupJid, {
      data: metadata,
      timestamp: Date.now()
    });

    return metadata;
  } catch (error) {
    logger.error(`[Session ${sessionId}] Error fetching group metadata: ${error.message}`);
    return null;
  }
}

// Extract phone number from participant ID (session-specific)
// WhatsApp now uses LIDs, but we can try to extract phone number from various sources
async function extractPhoneNumber(sessionId, participantId, groupMetadata, sock) {
  if (!participantId) return '';

  const sessionCache = phoneNumberCache.get(sessionId);
  if (!sessionCache) return '';

  // Check cache first
  if (sessionCache.has(participantId)) {
    logger.debug(`[Session ${sessionId}] Phone number found in cache for ${participantId}`);
    return sessionCache.get(participantId);
  }

  // Try to find participant in group metadata
  if (groupMetadata && groupMetadata.participants) {
    const participant = groupMetadata.participants.find(p => p.id === participantId);
    if (participant) {
      // Try to get phone from different sources
      if (participant.phone) {
        sessionCache.set(participantId, participant.phone);
        return participant.phone;
      }
    }
  }

  // Try to extract from participant ID directly
  const parts = participantId.split('@');
  if (parts.length > 0) {
    const potentialPhone = parts[0];

    if (/^[1-9]\d{8,14}$/.test(potentialPhone)) {
      sessionCache.set(participantId, potentialPhone);
      return potentialPhone;
    }
  }

  // Try using Baileys' onWhatsApp to fetch user info
  try {
    const [user] = await sock.onWhatsApp(participantId);
    if (user) {
      if (user.jid) {
        const jidParts = user.jid.split('@');
        if (jidParts.length > 0) {
          const potentialPhone = jidParts[0];
          if (/^[1-9]\d{8,14}$/.test(potentialPhone)) {
            logger.info(`[Session ${sessionId}] Found phone number via onWhatsApp.jid: ${potentialPhone}`);
            sessionCache.set(participantId, potentialPhone);
            return potentialPhone;
          }
        }
      }
      if (user.number) {
        const num = user.number.toString();
        logger.info(`[Session ${sessionId}] Found phone number via onWhatsApp.number: ${num}`);
        sessionCache.set(participantId, num);
        return num;
      }
    }
  } catch (error) {
    logger.debug(`[Session ${sessionId}] onWhatsApp failed for ${participantId}: ${error.message}`);
  }

  // LID format (cannot extract phone number)
  return '';
}

// WhatsApp connection handler (session-specific)
async function connectToWhatsAppSession(sessionId) {
  const authInfoPath = getAuthInfoPath(sessionId);

  logger.info(`[Session ${sessionId}] Connecting to WhatsApp...`);

  const { state, saveCreds } = await useMultiFileAuthState(authInfoPath);

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: ["ORIN CRM Bot", "Chrome", "1.0.0"]
  });

  // Initialize session caches
  initSessionCaches(sessionId);

  // Store session data
  sessionManager.setSession(sessionId, {
    sock,
    isConnected: false,
    latestQR: null
  });

  // Handle connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessionManager.getSession(sessionId);

    if (qr) {
      logger.info(`[Session ${sessionId}] QR Code received. Scan with WhatsApp:`);
      if (session) {
        session.latestQR = qr;
      }
      // Still display in terminal for convenience
      QRCode.toString(qr, { type: 'terminal' }, function (error, url) {
        if (error) console.error(error);
        console.log(url);
      });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      logger.info(`[Session ${sessionId}] Connection closed. Reconnecting:`, shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsAppSession(sessionId), 5000);
      } else {
        logger.info(`[Session ${sessionId}] Connection closed. User logged out`);
        if (session) {
          session.isConnected = false;
          session.latestQR = null;
        }
      }
    } else if (connection === 'open') {
      logger.info(`[Session ${sessionId}] WhatsApp connection opened!`);
      if (session) {
        session.isConnected = true;
        session.latestQR = null;
      }
    }
  });

  // Handle credentials update
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const msg of messages) {
        if (!msg.key.fromMe) { // Ignore messages from bot itself
          await handleMessage(sessionId, msg);
        }
      }
    }
  });
}

// Message handler (session-specific)
async function handleMessage(sessionId, msg) {
  try {
    const message = msg.message;
    if (!message) return;

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.sock) {
      logger.error(`[Session ${sessionId}] Session not found or no socket available`);
      return;
    }

    const sock = session.sock;
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const pushName = msg.pushName;
    const participant = msg.key.participant;

    // Extract message content
    let text = '';
    if (message.conversation) {
      text = message.conversation;
    } else if (message.extendedTextMessage) {
      text = message.extendedTextMessage.text;
    }

    if (!text) return; // Skip non-text messages

    // Extract sender phone number correctly
    let senderPhone;
    let senderLid;

    if (isGroup) {
      // Group message: Try to get real phone number from group metadata
      const groupMetadata = await getGroupMetadata(sessionId, remoteJid, sock);
      senderPhone = await extractPhoneNumber(sessionId, participant, groupMetadata, sock);
      senderLid = participant || `${remoteJid.split('@')[0]}@lid`;

      if (!senderPhone) {
        logger.warn(`[Session ${sessionId}] Could not extract phone number for participant ${participant} in group ${remoteJid}`);
      }
    } else {
      // Individual message: Extract from remoteJid
      senderPhone = remoteJid.split('@')[0];
      senderLid = `${remoteJid.split('@')[0]}@lid`;

      // Cache this phone number for future group lookups
      const sessionCache = phoneNumberCache.get(sessionId);
      if (sessionCache) {
        sessionCache.set(remoteJid, senderPhone);
        logger.info(`[Session ${sessionId}] Cached phone number ${senderPhone} for ${remoteJid} from direct message`);
      }
    }

    // Broadcast to subscribed Python clients
    broadcastToClients(sessionId, {
      event: 'message',
      session: sessionId,
      data: {
        from: remoteJid,
        isGroupMsg: isGroup,
        fromMe: msg.key.fromMe || false,
        body: text,
        author: participant || pushName,
        id: msg.key.id,
        sender: {
          lid: senderLid,
          phoneNumber: senderPhone,
          name: pushName,
          pushName: pushName
        },
        timestamp: msg.messageTimestamp
      }
    });

    logger.info(`[Session ${sessionId}] Message from ${isGroup ? 'group' : 'chat'} ${remoteJid}: ${text} (phone: ${senderPhone || 'LID-only'})`);
  } catch (error) {
    logger.error(`[Session ${sessionId}] Error handling message:`, error);
  }
}

// REST API Endpoints

// QR Code display page (supports session parameter)
app.get('/qr', async (req, res) => {
  const sessionId = req.query.session || sessionConfig.defaultSession;
  const session = sessionManager.getSession(sessionId);

  const allSessionsStatus = sessionManager.getAllSessionsStatus();
  const sessionListHtml = Object.entries(allSessionsStatus)
    .filter(([id, status]) => id !== sessionId)
    .map(([id, status]) => `
      <li>
        <a href="/qr?session=${id}">${status.config.name || id}</a>
        ${status.connected ? '✓' : status.hasQR ? 'QR available' : 'Not connected'}
      </li>
    `).join('');

  if (!session || !session.latestQR) {
    const config = sessionConfig.sessions[sessionId];
    const sessionName = config?.name || sessionId;

    return res.status(503).send(`
      <html>
      <head><title>WhatsApp QR Code - ${sessionName}</title></head>
      <body>
        <h1>WhatsApp QR Code - ${sessionName}</h1>
        <p>No QR code available yet. Waiting for connection...</p>
        <script>
          // Auto-refresh every 10 seconds
          setTimeout(() => location.reload(), 10000);
        </script>
      </body>
      </html>
    `);
  }

  try {
    // Generate QR code as data URL
    const qrDataURL = await QRCode.toDataURL(session.latestQR);

    res.send(`
      <html>
      <head>
        <title>WhatsApp QR Code - ${sessionConfig.sessions[sessionId]?.name || sessionId}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #f5f5f5;
          }
          .container {
            text-align: center;
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 500px;
          }
          h1 {
            color: #333;
            margin-bottom: 20px;
          }
          .session-badge {
            display: inline-block;
            background: #007bff;
            color: white;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            margin-bottom: 15px;
          }
          #qrcode {
            margin: 20px auto;
          }
          #qrcode img {
            max-width: 300px;
            border: 2px solid #ddd;
            padding: 10px;
            background: white;
          }
          .status {
            margin-top: 20px;
            padding: 10px;
            border-radius: 5px;
            font-weight: bold;
          }
          .waiting {
            background: #fff3cd;
            color: #856404;
          }
          .connected {
            background: #d4edda;
            color: #155724;
          }
          .refresh-info {
            margin-top: 20px;
            color: #666;
            font-size: 14px;
          }
          .session-list {
            margin-top: 30px;
            text-align: left;
            border-top: 1px solid #ddd;
            padding-top: 20px;
          }
          .session-list h3 {
            font-size: 14px;
            color: #666;
            margin-bottom: 10px;
          }
          .session-list ul {
            list-style: none;
            padding: 0;
          }
          .session-list li {
            padding: 5px 0;
          }
          .session-list a {
            color: #007bff;
            text-decoration: none;
          }
          .session-list a:hover {
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <span class="session-badge">${sessionId}</span>
          <h1>WhatsApp QR Code</h1>
          <div id="qrcode">
            <img src="${qrDataURL}" alt="WhatsApp QR Code" />
          </div>
          <div class="status ${session.isConnected ? 'connected' : 'waiting'}">
            ${session.isConnected ? '✓ Connected!' : 'Waiting for scan...'}
          </div>
          <p class="refresh-info">
            ${session.isConnected ? 'Your WhatsApp is connected!' : 'Scan this code with WhatsApp to connect'}
          </p>
          ${!session.isConnected ? '<p class="refresh-info">This page will refresh automatically after connection</p>' : ''}
          ${sessionListHtml ? `
            <div class="session-list">
              <h3>Other Sessions:</h3>
              <ul>${sessionListHtml}</ul>
            </div>
          ` : ''}
        </div>
        ${!session.isConnected ? `<script>
          // Auto-refresh every 10 seconds to get new QR code if expired
          // Also check connection status and refresh when connected
          let refreshInterval = setInterval(() => {
            location.reload();
          }, 10000);

          // Check connection status more frequently
          setInterval(() => {
            fetch('/health?session=${sessionId}')
              .then(r => r.json())
              .then(data => {
                const sessionStatus = data.sessions?.['${sessionId}'];
                if (sessionStatus?.connected) {
                  clearInterval(refreshInterval); // Stop auto-refresh when connected
                  location.reload();
                }
              });
          }, 2000);
        </script>` : ''}
      </body>
      </html>
    `);
  } catch (error) {
    logger.error(`[Session ${sessionId}] Error generating QR code:`, error);
    res.status(500).send('Error generating QR code');
  }
});

// Health check (supports session parameter)
app.get('/health', (req, res) => {
  const sessionId = req.query.session;

  if (sessionId) {
    // Return status for specific session
    const sessionStatus = sessionManager.getSessionStatus(sessionId);
    res.json({
      status: 'ok',
      session: sessionId,
      ...sessionStatus,
      clients: wsClients.size
    });
  } else {
    // Return status for all sessions
    res.json({
      status: 'ok',
      defaultSession: sessionConfig.defaultSession,
      sessions: sessionManager.getAllSessionsStatus(),
      clients: wsClients.size,
      totalSessions: sessionManager.sessions.size
    });
  }
});

// Send text message (supports session parameter)
app.post('/api/send-text', async (req, res) => {
  try {
    const { to, message, session } = req.body;
    const sessionId = session || req.query.session || sessionConfig.defaultSession;

    const sessionData = sessionManager.getSession(sessionId);

    if (!sessionData || !sessionData.sock || !sessionData.isConnected) {
      return res.status(503).json({
        error: 'Not connected to WhatsApp',
        session: sessionId,
        connected: false
      });
    }

    if (!to || !message) {
      return res.status(400).json({ error: 'Missing required fields: to, message' });
    }

    await sessionData.sock.sendMessage(to, { text: message });

    res.json({
      success: true,
      message: 'Message sent successfully',
      session: sessionId
    });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get all groups (supports session parameter)
app.get('/api/groups', async (req, res) => {
  try {
    const sessionId = req.query.session || sessionConfig.defaultSession;
    const sessionData = sessionManager.getSession(sessionId);

    if (!sessionData || !sessionData.sock || !sessionData.isConnected) {
      return res.status(503).json({
        error: 'Not connected to WhatsApp',
        session: sessionId,
        connected: false
      });
    }

    const groups = await sessionData.sock.groupFetchAllParticipating();

    const groupList = Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0
    }));

    res.json({
      session: sessionId,
      groups: groupList
    });
  } catch (error) {
    logger.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Start servers
app.listen(PORT, () => {
  logger.info(`HTTP API server running on port ${PORT}`);
  logger.info(`WebSocket server running on port ${WS_PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`QR Code page: http://localhost:${PORT}/qr`);
  logger.info(`WebSocket endpoint: ws://localhost:${WS_PORT}?session=<session-id>`);
  logger.info(`Default session: ${sessionConfig.defaultSession}`);
});

// Connect all enabled WhatsApp sessions
const enabledSessions = Object.entries(sessionConfig.sessions)
  .filter(([_, config]) => config.enabled !== false)
  .map(([id, _]) => id);

logger.info(`Initializing ${enabledSessions.length} WhatsApp sessions: [${enabledSessions.join(', ')}]`);

// Start connections with slight delay to avoid overwhelming
enabledSessions.forEach((sessionId, index) => {
  setTimeout(() => {
    connectToWhatsAppSession(sessionId).catch((error) => {
      logger.error(`[Session ${sessionId}] Failed to connect:`, error);
    });
  }, index * 2000); // 2 second delay between each session
});
