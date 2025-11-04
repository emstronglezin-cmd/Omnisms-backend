require('dotenv').config();
const express = require('express');
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const groupRoutes = require('./routes/groups');
const audioRoutes = require('./routes/audio');
const paymentRoutes = require('./routes/payments');
const transcriptionRoutes = require('./routes/transcription');
const userRoutes = require('./routes/users');
const smsCostRoutes = require('./routes/smsCost');
const subscriptionRoutes = require('./routes/subscriptions');
const adsRoutes = require('./routes/ads');
const creditRoutes = require('./routes/credits');
const companyRoutes = require('./routes/companies');
const http = require('http');
const { Server } = require('socket.io');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ParseServer = require('parse-server').ParseServer;

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Temporarily disabled API key middleware
// app.use(apiKeyMiddleware);

// Health check endpoint
app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'Server is running' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/messages', messageRoutes);
app.use('/groups', groupRoutes);
app.use('/audio', audioRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/transcription', transcriptionRoutes);
app.use('/users', userRoutes);
app.use('/sms-cost', smsCostRoutes);
app.use('/subscriptions', subscriptionRoutes);
app.use('/ads', adsRoutes);
app.use('/credits', creditRoutes);
app.use('/companies', companyRoutes);

// Configure Parse Server
const parseServer = new ParseServer({
  databaseURI: process.env.PARSE_DATABASE_URI, // Back4App database URI
  cloud: './cloud/main.js', // Path to your Cloud Code
  appId: process.env.PARSE_APP_ID,
  masterKey: process.env.PARSE_MASTER_KEY, // Keep this key secret!
  serverURL: process.env.PARSE_SERVER_URL, // URL of your Parse Server
});

// Mount Parse Server on /parse
app.use('/parse', parseServer.app);

// Socket.io setup
const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});