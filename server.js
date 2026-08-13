const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const allowedBars = new Set(['JEREMIAS GANIM', 'MARIAN VERON', 'ALEX GANDARIAS', 'LUNA UGARTE']);
const allowedServices = new Set(['CORTE CLASICO', 'CORTE Y BARBA', 'CORTE PARA FEMENINOS']);
const requestLogs = new Map();

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLogs.get(ip);

  if (!entry) {
    requestLogs.set(ip, { count: 1, firstAt: now });
    return false;
  }

  const elapsed = now - entry.firstAt;
  if (elapsed < 60000) {
    entry.count += 1;
    if (entry.count > 10) {
      return true;
    }
    return false;
  }

  requestLogs.set(ip, { count: 1, firstAt: now });
  return false;
}

function validateBooking(booking) {
  if (!booking || typeof booking !== 'object') return false;
  if (!allowedBars.has(booking.barber)) return false;
  if (!allowedServices.has(booking.service)) return false;
  if (typeof booking.datetime !== 'string' || !booking.datetime.trim()) return false;

  const parsedDate = new Date(booking.datetime);
  if (Number.isNaN(parsedDate.getTime())) return false;

  if (typeof booking.hoursBefore !== 'undefined' && (Number(booking.hoursBefore) < 1 || Number(booking.hoursBefore) > 24)) return false;

  return true;
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error interno del servidor');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const clientIp = req.socket.remoteAddress || 'unknown';

  if (req.method === 'POST' && req.url === '/api/book') {
    if (isRateLimited(clientIp)) {
      return sendJson(res, 429, { ok: false, error: 'Demasiadas peticiones. Intenta nuevamente más tarde.' });
    }

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        if (!body || body.trim() === '') {
          return sendJson(res, 400, { ok: false, error: 'Body vacío' });
        }

        const booking = JSON.parse(body);
        if (!validateBooking(booking)) {
          return sendJson(res, 400, { ok: false, error: 'Datos de reserva inválidos' });
        }

        const bookingsFile = path.join(__dirname, 'bookings.json');
        let bookings = [];
        try {
          const raw = fs.readFileSync(bookingsFile, 'utf8');
          bookings = JSON.parse(raw || '[]');
        } catch (e) {
          bookings = [];
        }

        bookings.push(Object.assign({ id: Date.now() }, booking));
        fs.writeFileSync(bookingsFile, JSON.stringify(bookings, null, 2));

        scheduleReminder(booking).catch(err => console.error('Error scheduling reminder:', err));
        return sendJson(res, 200, { ok: true, message: 'Reserva guardada. Se programó el recordatorio.' });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: 'JSON inválido' });
      }
    });
    return;
  }

  const requestedUrl = req.url === '/' ? '/index.html' : req.url;
  if (requestedUrl.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Ruta inválida');
    return;
  }

  const filePath = path.join(publicDir, requestedUrl);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Ruta inválida');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Página no encontrada');
      return;
    }
    sendFile(res, filePath, contentType);
  });
});

server.listen(port, () => {
  console.log(`Servidor iniciado en el puerto ${port}`);
  console.log(`URL local: http://localhost:${port}`);
});

async function scheduleReminder(booking) {
  const { datetime, barber, service } = booking;
  const hoursBefore = booking.hoursBefore || 1;
  const when = new Date(datetime).getTime() - hoursBefore * 3600 * 1000;
  const now = Date.now();
  const delay = Math.max(0, when - now);

  const send = async () => {
    const message = `Nuevo turno reservado: ${barber} para ${service} el ${new Date(datetime).toLocaleString('es-ES')}.`;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    const businessNumber = 'whatsapp:+542281582346';
    const to = process.env.TWILIO_WHATSAPP_TO || process.env.TWILIO_WHATSAPP_FROM || businessNumber;

    if (accountSid && authToken && from) {
      try {
        const Twilio = require('twilio');
        const client = Twilio(accountSid, authToken);
        await client.messages.create({ body: message, from, to });
        console.log('Notificación enviada por WhatsApp al negocio:', to);
        return;
      } catch (e) {
        console.error('Error enviando vía Twilio:', e);
      }
    }

    const logLine = `${new Date().toISOString()} | To: ${to} | ${message}${os.EOL}`;
    fs.appendFile(path.join(__dirname, 'reminders.log'), logLine, () => {});
    console.log('Notificación registrada (simulada) para el negocio:', to);
  };

  if (delay === 0) {
    await send();
  } else {
    setTimeout(send, delay);
  }
}
