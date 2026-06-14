const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode-terminal');

const logger = pino({ level: 'info' });
const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Global state
let sock = null;
let isConnected = false;
const wsClients = new Set();

// Group metadata cache to avoid frequent API calls
const groupMetadataCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Auth state storage
const authInfoPath = path.join(__dirname, 'auth_info');
if (!fs.existsSync(authInfoPath)) {
    fs.mkdirSync(authInfoPath, { recursive: true });
}

// WebSocket Server for pushing events to Python app
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
    logger.info('New Python client connected');
    wsClients.add(ws);

    ws.on('close', () => {
        logger.info('Python client disconnected');
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
    });
});

// Broadcast message to all connected Python clients
function broadcastToClients(data) {
    const message = JSON.stringify(data);
    wsClients.forEach((client) => {
        if (client.readyState === 1) { // OPEN
            client.send(message);
        }
    });
}

// Get group metadata with caching
async function getGroupMetadata(groupJid) {
    try {
        // Check cache first
        const cached = groupMetadataCache.get(groupJid);
        if (cached && (Date.now() - cached.timestamp) < GROUP_CACHE_TTL) {
            return cached.data;
        }

        // Fetch fresh metadata
        logger.info(`Fetching group metadata for ${groupJid}`);
        const metadata = await sock.groupMetadata(groupJid);

        // Cache it
        groupMetadataCache.set(groupJid, {
            data: metadata,
            timestamp: Date.now()
        });

        return metadata;
    } catch (error) {
        logger.error(`Error fetching group metadata: ${error.message}`);
        return null;
    }
}

// Extract phone number from participant ID
// WhatsApp now uses LIDs, but we can try to extract phone number from various sources
async function extractPhoneNumber(participantId, groupMetadata) {
    if (!participantId) return '';

    // Try to find participant in group metadata
    if (groupMetadata && groupMetadata.participants) {
        const participant = groupMetadata.participants.find(p => p.id === participantId);
        if (participant) {
            // Try to get phone from different sources
            // Some versions might have phone number in different fields
            if (participant.phone) {
                return participant.phone;
            }
        }
    }

    // Try to extract from participant ID directly
    // Format might be: "6281234567890@s.whatsapp.net" or "12816215965755@s.whatsapp.net"
    const parts = participantId.split('@');
    if (parts.length > 0) {
        const potentialPhone = parts[0];

        // Check if it looks like a phone number (starts with country code)
        // Indonesian numbers start with 62, other countries have different codes
        if (/^[1-9]\d{8,14}$/.test(potentialPhone)) {
            return potentialPhone;
        }
    }

    // Try using Baileys' onWhatsApp to fetch user info
    try {
        const [user] = await sock.onWhatsApp(participantId);
        if (user && user.number) {
            // Extract number from the result
            // The number field might contain the actual phone number
            const num = user.number.toString();
            logger.info(`Found phone number via onWhatsApp: ${num}`);
            return num;
        }
    } catch (error) {
        // Ignore error, just continue
        logger.debug(`onWhatsApp failed for ${participantId}: ${error.message}`);
    }

    // LID format (cannot extract phone number)
    return '';
}

// WhatsApp connection handler
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(authInfoPath);

    sock = makeWASocket({
        auth: state,
        logger,
        browser: ["ORIN CRM Bot", "Chrome", "1.0.0"]
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('QR Code received. Scan with WhatsApp:');
            QRCode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.info('Connection closed. Reconnecting:', shouldReconnect);

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                logger.info('Connection closed. User logged out');
            }
        } else if (connection === 'open') {
            logger.info('WhatsApp connection opened!');
            isConnected = true;
        }
    });

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe) { // Ignore messages from bot itself
                    await handleMessage(msg);
                }
            }
        }
    });
}

// Message handler
async function handleMessage(msg) {
    try {
        const message = msg.message;
        if (!message) return;

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

        // CRITICAL: Extract sender phone number correctly
        let senderPhone;
        let senderLid;

        if (isGroup) {
            // Group message: Try to get real phone number from group metadata
            const groupMetadata = await getGroupMetadata(remoteJid);
            senderPhone = await extractPhoneNumber(participant, groupMetadata);

            // If phone number not found, at least store the LID
            senderLid = participant || `${remoteJid.split('@')[0]}@lid`;

            if (!senderPhone) {
                logger.warn(`Could not extract phone number for participant ${participant} in group ${remoteJid}`);
            }
        } else {
            // Individual message: Extract from remoteJid
            // remoteJid format: "6281234567890@s.whatsapp.net"
            senderPhone = remoteJid.split('@')[0];
            senderLid = `${remoteJid.split('@')[0]}@lid`;
        }

        // Broadcast to Python clients
        broadcastToClients({
            event: 'message',
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

        logger.info(`Message from ${isGroup ? 'group' : 'chat'} ${remoteJid}: ${text} (phone: ${senderPhone || 'LID-only'})`);
    } catch (error) {
        logger.error('Error handling message:', error);
    }
}

// REST API Endpoints

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: isConnected,
        clients: wsClients.size
    });
});

// Send text message
app.post('/api/send-text', async (req, res) => {
    try {
        const { to, message } = req.body;

        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'Not connected to WhatsApp' });
        }

        if (!to || !message) {
            return res.status(400).json({ error: 'Missing required fields: to, message' });
        }

        await sock.sendMessage(to, { text: message });

        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        logger.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Get all groups
app.get('/api/groups', async (req, res) => {
    try {
        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'Not connected to WhatsApp' });
        }

        const groups = await sock.groupFetchAllParticipating();

        const groupList = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject,
            participants: g.participants?.length || 0
        }));

        res.json({ groups: groupList });
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
    logger.info(`WebSocket endpoint: ws://localhost:${WS_PORT}`);
});

// Connect to WhatsApp
connectToWhatsApp().catch((error) => {
    logger.error('Failed to connect to WhatsApp:', error);
});
