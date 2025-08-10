//
// index.js - Final Version for Koyeb Deployment
//
// This file contains the complete server-side logic for the movie and series management application.
// It includes a Telegram bot for administrative tasks and an Express server to expose a frontend.
//
// Final changes:
// - Fixed webhook URL configuration for Koyeb deployment
// - Added environment variable support
// - Improved error handling for webhook setup
// - Fixed port binding for Docker deployment
//

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// ================================================================
// CONFIGURATION
// ================================================================

// Use environment variables with fallbacks
const BOT_TOKEN = process.env.BOT_TOKEN || '7545348868:AAGjvrcDALv0O8fH5NmDzBkXFWrgIRdKYek';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/?retryWrites=true&w=majority&appName=movie';
const PORT = process.env.PORT || 8000;

// Create a secure path for the webhook URL
const webhookPath = `/webhook-${crypto.randomBytes(16).toString('hex')}`;

// Initialize bot without polling (for webhook mode)
const bot = new TelegramBot(BOT_TOKEN);

// ================================================================
// MONGODB CONNECTION & SCHEMAS
// ================================================================

// Fix mongoose deprecation warning
mongoose.set('strictQuery', false);

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Schemas
const movieSchema = new mongoose.Schema({
  name: { type: String, required: true },
  thumbnail: { type: String, required: true },
  streamingUrl: { type: String, required: true },
  addedBy: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now }
});

const seriesSchema = new mongoose.Schema({
  name: { type: String, required: true },
  thumbnail: { type: String, required: true },
  seasons: [{
    seasonNumber: { type: Number, required: true },
    episodes: [{
      episodeNumber: { type: Number, required: true },
      title: { type: String, required: true },
      streamingUrl: { type: String, required: true },
      thumbnail: String
    }]
  }],
  addedBy: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now }
});

const Movie = mongoose.model('Movie', movieSchema);
const Series = mongoose.model('Series', seriesSchema);

// ================================================================
// EXPRESS APP
// ================================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// ================================================================
// BOT STATE MANAGEMENT & CONVERSATION FLOWS
// ================================================================

// User states for bot conversation flow
const userStates = new Map();
const tempData = new Map();

// Global handler for bot messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  console.log(`Received message from ${userId}: ${text}`);

  try {
    // Handle bot commands and menu button presses
    if (text === '/start') {
      const keyboard = {
        reply_markup: {
          keyboard: [
            ['🎬 Add Movie', '📺 Add Series'],
            ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
            ['🌐 Open Frontend']
          ],
          resize_keyboard: true
        }
      };
      await bot.sendMessage(chatId, 'Welcome to Movie & Series Manager Bot! 🎭\n\nChoose an option:', keyboard);
    } else if (text === '🎬 Add Movie') {
      userStates.set(chatId, 'adding_movie_name');
      tempData.set(chatId, { type: 'movie' });
      await bot.sendMessage(chatId, '🎬 Enter the movie name:', { reply_markup: { remove_keyboard: true } });
    } else if (text === '📺 Add Series') {
      // New flow: Check for existing series first
      const seriesList = await Series.find({}, 'name');
      if (seriesList.length > 0) {
        const seriesKeyboard = seriesList.map(s => [{ text: s.name, callback_data: `add_to_series_${s._id}` }]);
        seriesKeyboard.push([{ text: 'Create New Series', callback_data: 'create_new_series' }]);
        await bot.sendMessage(chatId, 'Choose a series to add to, or create a new one:', {
          reply_markup: {
            inline_keyboard: seriesKeyboard
          }
        });
        userStates.set(chatId, 'choosing_series_for_add');
      } else {
        userStates.set(chatId, 'adding_series_name');
        tempData.set(chatId, { type: 'series' });
        await bot.sendMessage(chatId, '📺 Enter the series name:', { reply_markup: { remove_keyboard: true } });
      }
    } else if (text === '✍️ Edit/Delete Movies') {
      const movies = await Movie.find().limit(10);
      if (movies.length === 0) {
        await bot.sendMessage(chatId, 'No movies to edit or delete! 🎬');
      } else {
        let response = '🎬 *Select a movie to edit or delete:*\n\n';
        const movieKeyboard = movies.map(movie => [{
          text: `✍️ ${movie.name}`,
          callback_data: `edit_movie_${movie._id}`
        }, {
          text: `🗑️ ${movie.name}`,
          callback_data: `delete_movie_${movie._id}`
        }]);
        await bot.sendMessage(chatId, response, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: movieKeyboard
          }
        });
      }
    } else if (text === '🗑️ Edit/Delete Series') {
      const seriesList = await Series.find().limit(10);
      if (seriesList.length === 0) {
        await bot.sendMessage(chatId, 'No series to edit or delete! 📺');
      } else {
        let response = '📺 *Select a series to edit or delete:*\n\n';
        const seriesKeyboard = seriesList.map(series => [{
          text: `✍️ ${series.name}`,
          callback_data: `edit_series_${series._id}`
        }, {
          text: `🗑️ ${series.name}`,
          callback_data: `delete_series_${series._id}`
        }]);
        await bot.sendMessage(chatId, response, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: seriesKeyboard
          }
        });
      }
    } else if (text === '🌐 Open Frontend') {
      const frontendUrl = process.env.WEBHOOK_URL || `http://localhost:${PORT}`;
      await bot.sendMessage(chatId, `🌐 Frontend URL: ${frontendUrl}\n\nOpen this link to access the media player interface!`);
    } else {
      // Handle conversation flows
      await handleConversationFlow(chatId, text, userId);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
});

// Handle inline keyboard button presses (for edit/delete/add series)
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  console.log(`Received callback query: ${data}`);

  try {
    if (data.startsWith('add_to_series_')) {
      const seriesId = data.replace('add_to_series_', '');
      tempData.set(chatId, { type: 'series', seriesId: seriesId, seasons: [] });
      userStates.set(chatId, 'adding_season_number_existing');
      await bot.sendMessage(chatId, '🔢 Enter the new season number (or "done" to finish):', { reply_markup: { remove_keyboard: true } });
    } else if (data === 'create_new_series') {
      userStates.set(chatId, 'adding_series_name');
      tempData.set(chatId, { type: 'series' });
      await bot.sendMessage(chatId, '📺 Enter the series name:', { reply_markup: { remove_keyboard: true } });
    } else if (data.startsWith('delete_movie_')) {
      const movieId = data.replace('delete_movie_', '');
      try {
        await Movie.findByIdAndDelete(movieId);
        await bot.sendMessage(chatId, '✅ Movie deleted successfully!');
      } catch (error) {
        await bot.sendMessage(chatId, '❌ Error deleting movie.');
      }
    } else if (data.startsWith('delete_series_')) {
      const seriesId = data.replace('delete_series_', '');
      try {
        await Series.findByIdAndDelete(seriesId);
        await bot.sendMessage(chatId, '✅ Series deleted successfully!');
      } catch (error) {
        await bot.sendMessage(chatId, '❌ Error deleting series.');
      }
    }

    // Answer callback query to remove loading state
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred' });
  }
});

async function handleConversationFlow(chatId, text, userId) {
  const state = userStates.get(chatId);
  const data = tempData.get(chatId) || {};

  try {
    switch (state) {
      // --- Movie Addition Flow ---
      case 'adding_movie_name':
        data.name = text;
        userStates.set(chatId, 'adding_movie_thumbnail');
        await bot.sendMessage(chatId, '📸 Enter the movie thumbnail URL:');
        break;

      case 'adding_movie_thumbnail':
        data.thumbnail = text;
        userStates.set(chatId, 'adding_movie_streaming_url');
        await bot.sendMessage(chatId, '🔗 Enter the streaming URL:');
        break;

      case 'adding_movie_streaming_url':
        data.streamingUrl = text;
        try {
          const movie = new Movie({ ...data, addedBy: userId });
          await movie.save();
          await bot.sendMessage(chatId, `✅ Movie "${data.name}" added successfully!`, {
            reply_markup: {
              keyboard: [['🎬 Add Movie', '📺 Add Series'], ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'], ['🌐 Open Frontend']],
              resize_keyboard: true
            }
          });
        } catch (error) {
          await bot.sendMessage(chatId, '❌ Error adding movie. Please try again.');
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;

      // --- Series Creation Flow (for new series) ---
      case 'adding_series_name':
        data.name = text;
        userStates.set(chatId, 'adding_series_thumbnail');
        await bot.sendMessage(chatId, '📸 Enter the series thumbnail URL:');
        break;

      case 'adding_series_thumbnail':
        data.thumbnail = text;
        data.seasons = [];
        userStates.set(chatId, 'adding_season_number');
        await bot.sendMessage(chatId, '🔢 Enter season number (or "done" to finish):');
        break;
      
      // --- Series Addition Flow (for new seasons/episodes) ---
      case 'adding_season_number_existing':
      case 'adding_season_number':
        if (text.toLowerCase() === 'done') {
          if (data.seasons.length === 0) {
            await bot.sendMessage(chatId, '⚠️ Please add at least one season with episodes!');
            return;
          }
          const series = new Series({ ...data, addedBy: userId });
          await series.save();
          await bot.sendMessage(chatId, `✅ Series "${data.name}" added successfully!`, {
            reply_markup: {
              keyboard: [['🎬 Add Movie', '📺 Add Series'], ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'], ['🌐 Open Frontend']],
              resize_keyboard: true
            }
          });
          userStates.delete(chatId);
          tempData.delete(chatId);
          return;
        }
        const seasonNumber = parseInt(text);
        if (isNaN(seasonNumber) || seasonNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid season number!');
          return;
        }
        data.currentSeason = { seasonNumber, episodes: [] };
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Season ${seasonNumber} - Enter episode number (or "next" for new season, "done" to finish):`);
        break;
      
      case 'adding_episode_number':
        if (text.toLowerCase() === 'next') {
          if (data.currentSeason.episodes.length === 0) {
            await bot.sendMessage(chatId, '⚠️ Please add at least one episode to this season!');
            return;
          }
          data.seasons.push(data.currentSeason);
          userStates.set(chatId, 'adding_season_number');
          await bot.sendMessage(chatId, '🔢 Enter next season number (or "done" to finish):');
          return;
        }
        if (text.toLowerCase() === 'done') {
          if (data.currentSeason && data.currentSeason.episodes.length > 0) {
            data.seasons.push(data.currentSeason);
          }
          if (data.seasons.length === 0) {
            await bot.sendMessage(chatId, '⚠️ Please add at least one season with episodes!');
            return;
          }
          try {
            const series = new Series({ ...data, addedBy: userId });
            await series.save();
            await bot.sendMessage(chatId, `✅ Series "${data.name}" with ${data.seasons.length} season(s) added successfully!`, {
              reply_markup: {
                keyboard: [['🎬 Add Movie', '📺 Add Series'], ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'], ['🌐 Open Frontend']],
                resize_keyboard: true
              }
            });
            userStates.delete(chatId);
            tempData.delete(chatId);
          } catch (error) {
            await bot.sendMessage(chatId, '❌ Error adding series. Please try again.');
          }
          return;
        }
        const episodeNumber = parseInt(text);
        if (isNaN(episodeNumber) || episodeNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid episode number!');
          return;
        }
        data.currentEpisode = { episodeNumber };
        userStates.set(chatId, 'adding_episode_title');
        await bot.sendMessage(chatId, `📺 S${data.currentSeason.seasonNumber}E${episodeNumber} - Enter episode title:`);
        break;

      case 'adding_episode_title':
        data.currentEpisode.title = text;
        userStates.set(chatId, 'adding_episode_url');
        await bot.sendMessage(chatId, '🔗 Enter episode streaming URL:');
        break;

      case 'adding_episode_url':
        data.currentEpisode.streamingUrl = text;
        data.currentSeason.episodes.push(data.currentEpisode);
        await bot.sendMessage(chatId, `✅ Episode added! S${data.currentSeason.seasonNumber}E${data.currentEpisode.episodeNumber}: ${data.currentEpisode.title}\n\n📺 Enter next episode number (or "next" for new season, "done" to finish):`);
        userStates.set(chatId, 'adding_episode_number');
        break;

      default:
        // Ignore messages that don't match any state
        break;
    }
    tempData.set(chatId, data);
  } catch (error) {
    console.error('Error in conversation flow:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
}

// ================================================================
// API ENDPOINTS
// ================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Endpoint to fetch all movies
app.get('/api/movies', async (req, res) => {
  try {
    const movies = await Movie.find().sort({ addedAt: -1 });
    res.json(movies);
  } catch (error) {
    console.error('Error fetching movies:', error);
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

// Endpoint to fetch all series
app.get('/api/series', async (req, res) => {
  try {
    const series = await Series.find().sort({ addedAt: -1 });
    res.json(series);
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// Endpoint to fetch a single series by ID
app.get('/api/series/:id', async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    res.json(series);
  } catch (error) {
    console.error('Error fetching series details:', error);
    res.status(500).json({ error: 'Failed to fetch series details' });
  }
});

// ================================================================
// WEBHOOK SETUP & SERVER START
// ================================================================

// Webhook endpoint for Telegram updates
app.post(webhookPath, (req, res) => {
  console.log('Received webhook update');
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook update:', error);
    res.sendStatus(500);
  }
});

// Serve frontend - create a simple HTML page if index.html doesn't exist
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  
  // Check if index.html exists, if not serve a simple response
  try {
    res.sendFile(indexPath);
  } catch (error) {
    res.send(`
      <html>
        <body>
          <h1>Movie & TV Series Bot</h1>
          <p>Bot is running successfully!</p>
          <p>Use your Telegram bot to add movies and series.</p>
          <p>API Endpoints:</p>
          <ul>
            <li><a href="/api/movies">/api/movies</a> - Get all movies</li>
            <li><a href="/api/series">/api/series</a> - Get all series</li>
            <li><a href="/health">/health</a> - Health check</li>
          </ul>
        </body>
      </html>
    `);
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend available at: http://localhost:${PORT}`);
  
  // Get webhook URL from environment or construct it
  let webhookUrl = process.env.WEBHOOK_URL;
  
  if (!webhookUrl) {
    // Try to get from Koyeb environment variables
    const koyebAppName = process.env.KOYEB_APP_NAME;
    const koyebRegion = process.env.KOYEB_REGION || 'fra';
    
    if (koyebAppName) {
      webhookUrl = `https://${koyebAppName}.koyeb.app`;
    } else {
      console.log('No webhook URL configured. Skipping webhook setup.');
      console.log('Set WEBHOOK_URL environment variable or KOYEB_APP_NAME for webhook functionality.');
      return;
    }
  }
  
  const fullWebhookUrl = webhookUrl + webhookPath;
  
  try {
    await bot.setWebHook(fullWebhookUrl);
    console.log(`✅ Webhook set successfully to: ${fullWebhookUrl}`);
    console.log('🤖 Telegram Bot started via webhook');
    console.log('📱 Use /start in your bot to begin');
  } catch (error) {
    console.error('❌ Error setting webhook:', error.message);
    console.log('🔄 App is still running - you can set the webhook manually or check the WEBHOOK_URL environment variable');
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
  }
  process.exit(0);
});
