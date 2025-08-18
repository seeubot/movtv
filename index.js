// This file contains the main logic for the Telegram bot and Express API.

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// ================================================================
// CONFIGURATION
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 1024;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
// FIX: Use the provided Koyeb URL for the frontend.
const KOYEB_URL = 'https://comparable-cornela-seeutech-95c15254.koyeb.app';
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not found in environment variables. Please set it.');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables. Please set it.');
  process.exit(1);
}
if (USE_WEBHOOK && !KOYeb_URL) {
  console.error('❌ KOYEB_URL is required for webhook mode. Please set it.');
  process.exit(1);
}

let bot;
if (USE_WEBHOOK) {
  bot = new TelegramBot(BOT_TOKEN, { onlyFirstMatch: true });
  console.log('🤖 Bot initialized for Webhook mode. Waiting for Express to start...');
} else {
  console.log('🤖 Bot started in Polling mode.');
  console.warn('⚠️ Polling mode can cause issues on platforms like Koyeb. Consider using webhook mode.');
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
}

// ================================================================
// MONGODB CONNECTION & SCHEMAS
// ================================================================

mongoose.set('strictQuery', false);

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// ✨ UPDATED: Consolidated schema to handle all media types
const mediaSchema = new mongoose.Schema({
  name: { type: String, required: true },
  thumbnail: { type: String, required: true },
  streamingUrl: { type: String, required: true },
  description: { type: String, default: 'No description provided.' },
  type: { type: String, required: true, default: 'movie' },
  addedBy: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now }
});

mediaSchema.index({ name: 'text' });

const Media = mongoose.model('Media', mediaSchema);

// ================================================================
// EXPRESS APP & MIDDLEWARE
// ================================================================

const app = express();

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.00.1:3001',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  KOYEB_URL,
  'https://seeubot.github.io'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from the specified Origin.`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

if (USE_WEBHOOK) {
  app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// BOT STATE MANAGEMENT & CONVERSATION FLOWS
// ================================================================

const userStates = new Map();
const tempData = new Map();

bot.on('polling_error', (error) => {
  console.error('❌ Telegram polling error:', error.code, error.message);
});

bot.on('webhook_error', (error) => {
  console.error('❌ Telegram webhook error:', error);
});

const getMainMenuKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['🎬 Add Media'],
      ['✍️ Edit/Delete Media'],
      ['🌐 Frontend URL', '📊 Library Stats']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
});

const extractId = (data, prefix) => {
  if (data.startsWith(prefix)) {
    return data.substring(prefix.length);
  }
  return null;
};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  console.log(`📱 Message from ${userId}: ${text}`);

  try {
    if (text === '/start') {
      userStates.delete(chatId);
      tempData.delete(chatId);
      await bot.sendMessage(chatId,
        '🎭 *Welcome to Media Manager Bot!*\n\n' +
        '🎬 Add and manage your media\n' +
        '🌐 Access your media library via web frontend\n\n' +
        'Choose an option below:',
        { ...getMainMenuKeyboard(), parse_mode: 'Markdown' }
      );
    } else if (text === '🎬 Add Media') {
      userStates.set(chatId, 'adding_media_name');
      tempData.set(chatId, { addedBy: userId });
      await bot.sendMessage(chatId, '🎬 Enter the media name:', { reply_markup: { remove_keyboard: true } });
    } else if (text === '✍️ Edit/Delete Media') {
      const mediaList = await Media.find().sort({ addedAt: -1 }).limit(10);
      if (mediaList.length === 0) {
        await bot.sendMessage(chatId, '📽️ No media found! Add some first.', getMainMenuKeyboard());
      } else {
        const mediaKeyboard = mediaList.map(media => [
          { text: `✍️ ${media.name}`, callback_data: `edit_media_${media._id}` },
          { text: `🗑️ ${media.name}`, callback_data: `delete_media_${media._id}` }
        ]);
        await bot.sendMessage(chatId, '🎬 *Select media to edit or delete:*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: mediaKeyboard }
        });
      }
    } else if (text === '🌐 Frontend URL') {
      const frontendUrl = 'https://seeubot.github.io/NS';
      await bot.sendMessage(chatId,
        `🌐 *Web Frontend:*\n${frontendUrl}\n\n` +
        `📱 *API Server:* ${KOYEB_URL}/api\n\n` +
        '🎬 Open the frontend URL to watch your media!\n\n' +
        '✨ Your media library awaits!',
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
      );
    } else if (text === '📊 Library Stats') {
      const mediaCount = await Media.countDocuments();
      await bot.sendMessage(chatId,
        `📊 *Library Statistics:*\n\n` +
        `🎬 Total Media: ${mediaCount}`,
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
      );
    } else {
      await handleConversationFlow(chatId, text, userId);
    }
  } catch (error) {
    console.error('❌ Error handling message:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again or use /start to restart.', getMainMenuKeyboard());
    userStates.delete(chatId);
    tempData.delete(chatId);
  }
});

bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  console.log(`🔘 Callback query: ${data}`);

  try {
    if (data.startsWith('delete_media_')) {
      const mediaId = extractId(data, 'delete_media_');
      const deletedMedia = await Media.findByIdAndDelete(mediaId);
      if (deletedMedia) {
        await bot.sendMessage(chatId, `✅ Media "${deletedMedia.name}" deleted successfully!`, getMainMenuKeyboard());
      } else {
        await bot.sendMessage(chatId, '❌ Media not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('edit_media_')) {
      const mediaId = extractId(data, 'edit_media_');
      const media = await Media.findById(mediaId);
      if (media) {
        tempData.set(chatId, { mediaId, ...media._doc });
        userStates.set(chatId, 'editing_media');
        await bot.sendMessage(chatId,
          `🎬 *Editing Media: ${media.name}*\n\n` +
          `What would you like to edit?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✍️ Edit Name', callback_data: `edit_field_media_name` }],
                [{ text: '📸 Edit Thumbnail URL', callback_data: `edit_field_media_thumbnail` }],
                [{ text: '🔗 Edit Streaming URL', callback_data: `edit_field_media_streaming_url` }],
                [{ text: '📜 Edit Description', callback_data: `edit_field_media_description` }],
                [{ text: '🏷️ Edit Type', callback_data: `edit_field_media_type` }],
                [{ text: '❌ Cancel', callback_data: 'cancel' }]
              ]
            }
          }
        );
      } else {
        await bot.sendMessage(chatId, '❌ Media not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('edit_field_media_')) {
      const userData = tempData.get(chatId);
      if (!userData || !userData.mediaId) {
        await bot.sendMessage(chatId, '❌ No media selected for editing. Please try again.', getMainMenuKeyboard());
        return;
      }
      const fieldToEdit = extractId(data, 'edit_field_media_');
      userStates.set(chatId, `editing_media_${fieldToEdit}`);
      await bot.sendMessage(chatId, `✍️ Enter the new media ${fieldToEdit.replace(/_/g, ' ')}:`);
    } else if (data === 'cancel') {
      userStates.delete(chatId);
      tempData.delete(chatId);
      await bot.sendMessage(chatId, 'Operation canceled.', getMainMenuKeyboard());
    }
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('❌ Error handling callback query:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred' });
    userStates.delete(chatId);
    tempData.delete(chatId);
  }
});

async function handleConversationFlow(chatId, text, userId) {
  const state = userStates.get(chatId);
  const data = tempData.get(chatId) || {};
  try {
    switch (state) {
      case 'adding_media_name':
        data.name = text.trim();
        userStates.set(chatId, 'adding_media_thumbnail');
        await bot.sendMessage(chatId, '📸 Enter the media thumbnail URL (image):');
        break;
      case 'adding_media_thumbnail':
        data.thumbnail = text.trim();
        userStates.set(chatId, 'adding_media_url');
        await bot.sendMessage(chatId, '🔗 Enter the streaming URL (.mp4, .m3u8, etc.):');
        break;
      case 'adding_media_url':
        data.streamingUrl = text.trim();
        userStates.set(chatId, 'adding_media_description');
        await bot.sendMessage(chatId, '📜 Enter a short description:');
        break;
      case 'adding_media_description':
        data.description = text.trim();
        userStates.set(chatId, 'adding_media_type');
        await bot.sendMessage(chatId, '🏷️ Enter a type (e.g., "Movie", "Show", "Anime"):');
        break;
      case 'adding_media_type':
        data.type = text.trim();
        try {
          const media = new Media({ ...data, addedBy: userId });
          await media.save();
          await bot.sendMessage(chatId, `✅ Media "${data.name}" added successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error saving media:', error);
          await bot.sendMessage(chatId, '❌ Error adding media. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_media_name':
        try {
          await Media.findByIdAndUpdate(data.mediaId, { name: text.trim() });
          await bot.sendMessage(chatId, `✅ Media name updated to "${text.trim()}"!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating media name:', error);
          await bot.sendMessage(chatId, '❌ Error updating media name. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_media_thumbnail':
        try {
          await Media.findByIdAndUpdate(data.mediaId, { thumbnail: text.trim() });
          await bot.sendMessage(chatId, `✅ Media thumbnail updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating media thumbnail:', error);
          await bot.sendMessage(chatId, '❌ Error updating media thumbnail. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_media_streaming_url':
        try {
          await Media.findByIdAndUpdate(data.mediaId, { streamingUrl: text.trim() });
          await bot.sendMessage(chatId, `✅ Media streaming URL updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating media streaming URL:', error);
          await bot.sendMessage(chatId, '❌ Error updating media streaming URL. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_media_description':
        try {
          await Media.findByIdAndUpdate(data.mediaId, { description: text.trim() });
          await bot.sendMessage(chatId, `✅ Media description updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating media description:', error);
          await bot.sendMessage(chatId, '❌ Error updating media description. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_media_type':
        try {
          await Media.findByIdAndUpdate(data.mediaId, { type: text.trim() });
          await bot.sendMessage(chatId, `✅ Media type updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating media type:', error);
          await bot.sendMessage(chatId, '❌ Error updating media type. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      default:
        await bot.sendMessage(chatId, '❓ I didn\'t understand that. Please use the menu buttons or type /start to restart.', getMainMenuKeyboard());
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
    }
    if (data && Object.keys(data).length > 0) {
      tempData.set(chatId, data);
    }
  } catch (error) {
    console.error('❌ Error in conversation flow:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again or use /start to restart.', getMainMenuKeyboard());
    userStates.delete(chatId);
    tempData.delete(chatId);
  }
}

// ================================================================
// API ENDPOINTS FOR FRONTEND
// ================================================================

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    bot: USE_WEBHOOK ? 'webhook' : 'polling',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.get('/api/media', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = {};
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }
    if (type) {
      query.type = type;
    }
    const results = await Media.find(query).sort({ addedAt: -1 }).limit(parseInt(limit)).skip(offset);
    res.json(results);
  } catch (error) {
    console.error('❌ Error fetching media:', error);
    res.status(500).json({ error: 'Failed to fetch media', details: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const mediaCount = await Media.countDocuments();
    res.json({
      total: mediaCount
    });
  } catch (error) {
    console.error('❌ Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading index.html:', err);
      return res.status(500).send('Error loading frontend');
    }
    const apiBaseUrl = KOYEB_URL ? `${KOYEB_URL}/api` : `http://localhost:${PORT}/api`;
    const updatedHtml = data.replace(
      /const API_BASE_URL = [^;]+;/,
      `const API_BASE_URL = '${apiBaseUrl}';`
    );
    res.send(updatedHtml);
  });
});

app.get('/api', (req, res) => {
  res.json({
    name: 'Media Manager API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      media: '/api/media?search=...&type=...',
      stats: '/api/stats',
      health: '/health'
    },
    message: 'Frontend is available at the root URL /'
  });
});

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error', details: error.message });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 Media Manager API Server running on port', PORT);
  console.log('🌐 API Base URL:', KOYEB_URL ? `${KOYEB_URL}/api` : `http://localhost:${PORT}/api`);
  console.log('🤖 Bot mode:', USE_WEBHOOK ? 'Webhook' : 'Polling');

  if (USE_WEBHOOK && KOYEB_URL) {
    const webhookUrl = `${KOYEB_URL}${WEBHOOK_PATH}`;
    console.log(`Setting Telegram webhook to: ${webhookUrl}`);
    try {
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook set successfully!');
    } catch (e) {
      console.error('❌ Failed to set webhook:', e.message);
    }
  }

  console.log('📋 Available endpoints:');
  console.log('   • GET  /api/media      - Get all media');
  console.log('   • GET  /api/stats      - Get library statistics');
  console.log('   • GET  /health         - Health check');
  console.log('✅ Server ready! Connect your frontend to this API.');
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  try {
    if (!USE_WEBHOOK) bot.stopPolling();
    await mongoose.connection.close();
    console.log('✅ Shutdown complete');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  try {
    if (!USE_WEBHOOK) bot.stopPolling();
    await mongoose.connection.close();
    console.log('✅ Shutdown complete');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});


