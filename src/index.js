const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PUPPETEER_CACHE_DIR = '/opt/render/.cache/puppeteer';
const PUPPETEER_CHROMIUM_REVISION = '1108769';

function findChromePath() {
  const possiblePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    path.join(PUPPETEER_CACHE_DIR, 'chrome', 'linux-146.0.7680.76', 'chrome-linux64', 'chrome'),
    path.join(PUPPETEER_CACHE_DIR, 'chrome', 'linux-1108769', 'chrome-linux', 'chrome'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  try {
    return execSync('which chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  const chromePath = findChromePath();
  if (chromePath) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
  }
}

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');

console.log('Chrome path:', process.env.PUPPETEER_EXECUTABLE_PATH);

const app = express();
app.use(express.json());

const sessions = new Map();

function createClient(sessionId) {
  const puppeteerOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join('sessions', sessionId)
    }),
    puppeteer: puppeteerOptions
  });

  const sessionData = {
    client,
    isReady: false,
    currentQr: null
  };

  client.on('qr', async (qr) => {
    sessionData.currentQr = qr;
    sessionData.isReady = false;
    console.log(`📱 QR actualizado para sesión ${sessionId} - disponible en /qr/${sessionId}`);
  });

  client.on('ready', () => {
    console.clear();
    console.log(`✅ Sesión ${sessionId} conectada!`);
    sessionData.isReady = true;
    sessionData.currentQr = null;
  });

  client.on('disconnected', () => {
    console.log(`⚠️ Sesión ${sessionId} desconectada`);
    sessionData.isReady = false;
  });

  client.on('auth_failure', () => {
    console.error(`❌ Error de autenticación en sesión ${sessionId}`);
    sessionData.isReady = false;
  });

  client.initialize();
  return sessionData;
}

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createClient(sessionId));
  }
  return sessions.get(sessionId);
}

app.get('/sessions', (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id,
    connected: data.isReady
  }));
  res.json({ sessions: sessionList });
});

app.post('/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  getOrCreateSession(sessionId);
  res.json({ success: true, message: `Sesión ${sessionId} creada`, qrUrl: `/qr/${sessionId}` });
});

app.delete('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  try {
    await session.client.destroy();
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

app.get('/qr/:sessionId/value', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  if (session.isReady) {
    return res.json({ value: null, connected: true });
  }

  if (!session.currentQr) {
    return res.json({ value: null, connected: false });
  }

  res.json({ value: session.currentQr, connected: false });
});

app.get('/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = getOrCreateSession(sessionId);

  if (session.isReady) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Conectado - ${sessionId}</title>
        <meta http-equiv="refresh" content="3;url=/status/${sessionId}">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
          .container { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #25D366; margin-bottom: 24px; }
          .status { margin-top: 20px; padding: 12px 24px; border-radius: 8px; background: #d4edda; color: #155724; font-weight: 500; }
          .redirect { margin-top: 16px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ ¡Conectado!</h1>
          <div class="status">Sesión: ${sessionId}</div>
          <p class="redirect">Redirigiendo en 3 segundos...</p>
        </div>
      </body>
      </html>
    `);
  }

  if (!session.currentQr) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Cargando QR...</title>
        <meta http-equiv="refresh" content="2">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
          .container { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
          h1 { color: #128c7e; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⏳ Generando QR...</h1>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(session.currentQr, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp QR - ${sessionId}</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
          .container { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #128c7e; margin-bottom: 24px; }
          img { border-radius: 8px; }
          .status { margin-top: 20px; padding: 12px 24px; border-radius: 8px; font-weight: 500; background: #fff3cd; color: #856404; }
          .refresh { margin-top: 16px; color: #666; font-size: 14px; }
          .session-badge { display: inline-block; background: #e9ecef; padding: 4px 12px; border-radius: 12px; font-size: 12px; color: #495057; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="session-badge">Sesión: ${sessionId}</div>
          <h1>📱 Conectar WhatsApp</h1>
          <img src="${qrImage}" alt="QR Code" />
          <div class="status">Escanea el código con tu WhatsApp</div>
          <p class="refresh">La página se actualiza automáticamente cada 5 segundos</p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  if (req.headers.accept?.includes('text/html')) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Status - ${sessionId}</title>
        <meta http-equiv="refresh" content="10">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
          .container { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
          .status { margin-top: 20px; padding: 12px 24px; border-radius: 8px; font-weight: 500; font-size: 18px; }
          .connected { background: #d4edda; color: #155724; }
          .disconnected { background: #f8d7da; color: #721c24; }
          h1 { ${session.isReady ? 'color: #25D366;' : 'color: #dc3545;' } }
          .info { margin-top: 20px; color: #666; font-size: 14px; }
          .session-badge { display: inline-block; background: #e9ecef; padding: 4px 12px; border-radius: 12px; font-size: 12px; color: #495057; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="session-badge">Sesión: ${sessionId}</div>
          <h1>${session.isReady ? '✅ Conectado' : '⚠️ No conectado'}</h1>
          <div class="status ${session.isReady ? 'connected' : 'disconnected'}">
            ${session.isReady ? 'WhatsApp vinculado y listo' : 'Escanea el QR en /qr/' + sessionId}
          </div>
          <p class="info">Esta página se actualiza cada 10 segundos</p>
        </div>
      </body>
      </html>
    `);
  }

  res.json({
    sessionId,
    connected: session.isReady,
    state: session.isReady ? 'connected' : 'disconnected'
  });
});

app.post('/send/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { number, message } = req.body;

  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  if (!number || !message) {
    return res.status(400).json({ error: 'Faltan número o mensaje' });
  }

  if (!session.isReady) {
    return res.status(503).json({ error: 'Cliente no conectado' });
  }

  try {
    const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
    await session.client.sendMessage(formattedNumber, message);
    res.json({ success: true, message: 'Mensaje enviado', sessionId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/chats/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  if (!session.isReady) {
    return res.status(503).json({ error: 'Cliente no conectado' });
  }

  try {
    const chats = await session.client.getChats();
    res.json(chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
  console.log(`🌐 Servidor API iniciado en http://localhost:${PORT}`);
  console.log(`📱 Gestión de sesiones en http://localhost:${PORT}/sessions`);
});