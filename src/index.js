const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(express.json());

const sessions = new Map();
const logger = pino({ level: 'info' });

async function createClient(sessionId) {
    const sessionDir = path.join('sessions', sessionId);
    if (!fs.existsSync('sessions')) fs.mkdirSync('sessions');
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: ['Whapp-API', 'Chrome', '1.0.0']
    });

    const sessionData = {
        sock,
        isReady: false,
        currentQr: null,
        status: 'initializing'
    };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            sessionData.currentQr = qr;
            sessionData.status = 'qr_ready';
            console.log(`📱 [${sessionId}] Nuevo QR generado`);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ [${sessionId}] Conexión cerrada. ¿Reconectar?: ${shouldReconnect}`);
            sessionData.isReady = false;
            sessionData.status = 'disconnected';
            
            if (shouldReconnect) {
                setTimeout(() => createClient(sessionId), 5000);
            } else {
                sessions.delete(sessionId);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            }
        } else if (connection === 'open') {
            console.log(`✅ [${sessionId}] Conexión abierta y lista!`);
            sessionData.isReady = true;
            sessionData.currentQr = null;
            sessionData.status = 'connected';
        }
    });

    // Manejar mensajes (opcional, por si quieres loguear algo)
    sock.ev.on('messages.upsert', (m) => {
        // console.log(JSON.stringify(m, undefined, 2));
    });

    sessions.set(sessionId, sessionData);
    return sessionData;
}

async function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        await createClient(sessionId);
    }
    return sessions.get(sessionId);
}

app.get('/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
        id,
        connected: data.isReady,
        status: data.status
    }));
    res.json({ sessions: sessionList });
});

app.post('/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    await getOrCreateSession(sessionId);
    res.json({ success: true, message: `Sesión ${sessionId} iniciando`, qrUrl: `/qr/${sessionId}` });
});

app.delete('/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    try {
        await session.sock.logout();
        sessions.delete(sessionId);
        
        const sessionPath = path.join('sessions', sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        res.json({ success: true, message: `Sesión ${sessionId} eliminada` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = await getOrCreateSession(sessionId);

    if (session.isReady) {
        return res.send(`
          <!DOCTYPE html><html><head><title>Conectado</title><meta http-equiv="refresh" content="3;url=/status/${sessionId}"></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#f0f2f5;">
            <div style="background:white; padding:40px; border-radius:16px; display:inline-block;">
                <h1 style="color:#25D366;">✅ ¡Conectado!</h1>
                <p>Sesión: ${sessionId}</p>
                <p style="color:#666;">Redirigiendo al estado...</p>
            </div>
          </body></html>
        `);
    }

    if (!session.currentQr) {
        return res.send(`
            <!DOCTYPE html><html><head><title>Cargando...</title><meta http-equiv="refresh" content="2"></head>
            <body style="font-family:sans-serif; text-align:center; padding:50px; background:#f0f2f5;">
                <h1>⏳ Generando QR de Baileys...</h1>
            </body></html>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(session.currentQr, { width: 300 });
        res.send(`
          <!DOCTYPE html><html><head><title>Baileys QR - ${sessionId}</title><meta http-equiv="refresh" content="5"></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#f0f2f5;">
            <div style="background:white; padding:40px; border-radius:16px; display:inline-block;">
                <p style="background:#e9ecef; display:inline-block; padding:4px 12px; border-radius:12px;">Sesión: ${sessionId}</p>
                <h1 style="color:#128c7e;">📱 Conectar WhatsApp (Baileys)</h1>
                <img src="${qrImage}" alt="QR Code" />
                <p>Escanea el código con tu WhatsApp</p>
            </div>
          </body></html>
        `);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    res.json({
        sessionId,
        connected: session.isReady,
        status: session.status
    });
});

app.post('/send/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { number, message } = req.body;
    const session = sessions.get(sessionId);

    if (!session || !session.isReady) {
        return res.status(503).json({ error: 'Sesión no lista' });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Mensaje enviado via Baileys' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Nota: Baileys no tiene una forma sencilla de listar chats sin usar un Store (memoria extra)
// Retornamos un mensaje informativo por ahora
app.get('/chats/:sessionId', async (req, res) => {
    res.json({ message: "La lista de chats no está disponible en modo ultra-ligero de Baileys" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🌐 Baileys API iniciado en puerto ${PORT}`);
});