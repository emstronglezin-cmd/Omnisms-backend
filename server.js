require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fetch = require('node-fetch');
const { Server } = require('socket.io');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');

/* ========================================
   ROUTES
======================================== */
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const groupRoutes = require('./routes/groups');
const audioRoutes = require('./routes/audio');
const userRoutes = require('./routes/users');
const meRoutes = require('./routes/me');

/* ========================================
   APP + PORT
======================================== */
const app = express();
const PORT = process.env.PORT || 5000;

/* ========================================
   MIDDLEWARES
======================================== */
app.use(express.json({ limit: '10mb' }));
const paymentStartRoutes = require('./routes/payments.start');
app.use('/payments', paymentStartRoutes);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));


/* ========================================
   HEALTH CHECK
======================================== */
app.get('/api/status', (req, res) => {
  res.json({
    status: 'OmniSMS backend running',
    port: PORT,
    time: new Date().toISOString(),
  });
});

/* ========================================
   ROUTES
======================================== */
app.use('/auth', authRoutes);
app.use('/messages', messageRoutes);
app.use('/groups', groupRoutes);
app.use('/audio', audioRoutes); 
app.use('/users', userRoutes);
app.use('/me', meRoutes);

/* ========================================
   MONEYFUSION
======================================== */
app.post('/api/moneyfusion/init', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.moneyfusion.com/init',
      {
        amount: 2000,
        currency: 'XOF',
        phone: req.body.phone,
        countryCode: 'bf',
        description: 'Paiement OmniSMS',
        callback_url: process.env.MONEYFUSION_CALLBACK_URL,
        return_url: process.env.MONEYFUSION_RETURN_URL
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.MONEYFUSION_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error('MoneyFusion error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment init error' });
  }
});


/* ========================================
   WEBHOOK
======================================== */
app.post('/webhooks/moneyfusion', express.json(), (req, res) => {
  console.log('MoneyFusion webhook:', req.body);
  res.sendStatus(200);
});

/* ========================================
   SOCKET.IO
======================================== */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

/* ========================================
   START
======================================== */
server.listen(PORT, '0.0.0.0', () => {
  console.log('OmniSMS Backend running on port ' + PORT);
});

/* ========================================
   🔔 WEBHOOKS (AJOUT SÛR – NE CASSE RIEN)
   ======================================== */

// MoneyFusion
app.post('/webhooks/moneyfusion', express.json(), (req, res) => {
  console.log('💳 MoneyFusion webhook reçu:', req.body);
  res.status(200).json({ received: true });
});

// Twilio
app.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res) => {
  console.log('📩 Twilio webhook reçu:', req.body);
  res.status(200).send('OK');
});

// Orange
app.post('/webhooks/orange', express.json(), (req, res) => {
  console.log('🟧 Orange webhook reçu:', req.body);
  res.status(200).json({ received: true });
});





/* =========================================================
   🔗 ROUTES ADDITIONNELLES (AUTO-BRANCHÉES)
   ========================================================= */

try {
  app.use('/ads', require('./routes/ads'));
  app.use('/companies', require('./routes/companies'));
  app.use('/credits', require('./routes/credits'));
  app.use('/smsCost', require('./routes/smsCost'));
  app.use('/transcription', require('./routes/transcription'));
  app.use('/subscriptions', require('./routes/subscriptions'));
  app.use('/offline.payment', require('./routes/offline.payment'));
} catch (e) {
  console.warn('⚠️ Certaines routes optionnelles ne sont pas chargées:', e.message);
}

