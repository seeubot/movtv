//
// index.js - Updated Telegram Bot & Express Server
//
// This file contains the complete server-side logic for the movie and series management application.
// It includes a Telegram bot for administrative tasks and an Express server to expose a frontend.
//
// Changes made:
// - Switched from long polling to webhooks for bot updates. This is crucial for deployment on platforms like Koyeb.
// - Added commands and conversation flows for editing and deleting movies and series.
// - Modified the "Add Series" flow to allow adding seasons to an existing series.
// - Provided an endpoint for frontend interaction.
//

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // Used to generate a secure webhook path

// ================================================================
// CONFIGURATION
// ================================================================

// !!! IMPORTANT: Replace these with your actual tokens and URIs
const BOT_TOKEN = '7545348868:AAGjvrcDALv0O8fH5NmDzBkXFWrgIRdKYek';
const MONGODB_URI = 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/?retryWrites=true&w=majority&appName=movie';

// Create a secure path for the webhook URL
const webhookPath = `/webhook-${crypto.randomBytes(16).toString('hex')}`;
// The bot is now initialized without the `polling: true` option
const bot = new TelegramBot(BOT_TOKEN);

// ================================================================
// MONGODB CONNECTION & SCHEMAS
// ================================================================

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
app.use(express.json());
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
    bot.sendMessage(chatId, 'Welcome to Movie & Series Manager Bot! 🎭\n\nChoose an option:', keyboard);
  } else if (text === '🎬 Add Movie') {
    userStates.set(chatId, 'adding_movie_name');
    tempData.set(chatId, { type: 'movie' });
    bot.sendMessage(chatId, '🎬 Enter the movie name:', { reply_markup: { remove_keyboard: true } });
  } else if (text === '📺 Add Series') {
    // New flow: Check for existing series first
    const seriesList = await Series.find({}, 'name');
    if (seriesList.length > 0) {
      const seriesKeyboard = seriesList.map(s => [{ text: s.name, callback_data: `add_to_series_${s._id}` }]);
      seriesKeyboard.push([{ text: 'Create New Series', callback_data: 'create_new_series' }]);
      bot.sendMessage(chatId, 'Choose a series to add to, or create a new one:', {
        reply_markup: {
          inline_keyboard: seriesKeyboard
        }
      });
      userStates.set(chatId, 'choosing_series_for_add');
    } else {
      userStates.set(chatId, 'adding_series_name');
      tempData.set(chatId, { type: 'series' });
      bot.sendMessage(chatId, '📺 Enter the series name:', { reply_markup: { remove_keyboard: true } });
    }
  } else if (text === '✍️ Edit/Delete Movies') {
    const movies = await Movie.find().limit(10);
    if (movies.length === 0) {
      bot.sendMessage(chatId, 'No movies to edit or delete! 🎬');
    } else {
      let response = '🎬 *Select a movie to edit or delete:*\n\n';
      const movieKeyboard = movies.map(movie => [{
        text: `✍️ ${movie.name}`,
        callback_data: `edit_movie_${movie._id}`
      }, {
        text: `🗑️ ${movie.name}`,
        callback_data: `delete_movie_${movie._id}`
      }]);
      bot.sendMessage(chatId, response, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: movieKeyboard
        }
      });
    }
  } else if (text === '🗑️ Edit/Delete Series') {
    const seriesList = await Series.find().limit(10);
    if (seriesList.length === 0) {
      bot.sendMessage(chatId, 'No series to edit or delete! 📺');
    } else {
      let response = '📺 *Select a series to edit or delete:*\n\n';
      const seriesKeyboard = seriesList.map(series => [{
        text: `✍️ ${series.name}`,
        callback_data: `edit_series_${series._id}`
      }, {
        text: `🗑️ ${series.name}`,
        callback_data: `delete_series_${series._id}`
      }]);
      bot.sendMessage(chatId, response, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: seriesKeyboard
        }
      });
    }
  } else if (text === '🌐 Open Frontend') {
    bot.sendMessage(chatId, '🌐 Frontend URL: http://localhost:3000\n\nOpen this link to access the media player interface!');
  } else {
    // Handle conversation flows
    await handleConversationFlow(chatId, text, userId);
  }
});

// Handle inline keyboard button presses (for edit/delete/add series)
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  if (data.startsWith('add_to_series_')) {
    const seriesId = data.split('_')[2];
    tempData.set(chatId, { type: 'series', seriesId: seriesId, seasons: [] });
    userStates.set(chatId, 'adding_season_number_existing');
    bot.sendMessage(chatId, '🔢 Enter the new season number (or "done" to finish):', { reply_markup: { remove_keyboard: true } });
  } else if (data === 'create_new_series') {
    userStates.set(chatId, 'adding_series_name');
    tempData.set(chatId, { type: 'series' });
    bot.sendMessage(chatId, '📺 Enter the series name:', { reply_markup: { remove_keyboard: true } });
  } else if (data.startsWith('delete_movie_')) {
    const movieId = data.split('_')[2];
    try {
      await Movie.findByIdAndDelete(movieId);
      bot.sendMessage(chatId, '✅ Movie deleted successfully!');
    } catch (error) {
      bot.sendMessage(chatId, '❌ Error deleting movie.');
    }
  } else if (data.startsWith('delete_series_')) {
    const seriesId = data.split('_')[2];
    try {
      await Series.findByIdAndDelete(seriesId);
      bot.sendMessage(chatId, '✅ Series deleted successfully!');
    } catch (error) {
      bot.sendMessage(chatId, '❌ Error deleting series.');
    }
  }
});

async function handleConversationFlow(chatId, text, userId) {
  const state = userStates.get(chatId);
  const data = tempData.get(chatId) || {};

  switch (state) {
    // --- Movie Addition Flow ---
    case 'adding_movie_name':
      data.name = text;
      userStates.set(chatId, 'adding_movie_thumbnail');
      bot.sendMessage(chatId, '📸 Enter the movie thumbnail URL:');
      break;

    case 'adding_movie_thumbnail':
      data.thumbnail = text;
      userStates.set(chatId, 'adding_movie_streaming_url');
      bot.sendMessage(chatId, '🔗 Enter the streaming URL:');
      break;

    case 'adding_movie_streaming_url':
      data.streamingUrl = text;
      try {
        const movie = new Movie({ ...data, addedBy: userId });
        await movie.save();
        bot.sendMessage(chatId, `✅ Movie "${data.name}" added successfully!`, {
          reply_markup: {
            keyboard: [['🎬 Add Movie', '📺 Add Series'], ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'], ['🌐 Open Frontend']],
            resize_keyboard: true
          }
        });
      } catch (error) {
        bot.sendMessage(chatId, '❌ Error adding movie. Please try again.');
      }
      userStates.delete(chatId);
      tempData.delete(chatId);
      break;

    // --- Series Creation Flow (for new series) ---
    case 'adding_series_name':
      data.name = text;
      userStates.set(chatId, 'adding_series_thumbnail');
      bot.sendMessage(chatId, '📸 Enter the series thumbnail URL:');
      break;

    case 'adding_series_thumbnail':
      data.thumbnail = text;
      data.seasons = [];
      userStates.set(chatId, 'adding_season_number');
      bot.sendMessage(chatId, '🔢 Enter season number (or "done" to finish):');
      break;
    
    // --- Series Addition Flow (for new seasons/episodes) ---
    case 'adding_season_number_existing':
    case 'adding_season_number':
      if (text.toLowerCase() === 'done') {
        const series = new Series({ ...data, addedBy: userId });
        await series.save();
        bot.sendMessage(chatId, `✅ Series "${data.name}" added successfully!`, {
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
        bot.sendMessage(chatId, '⚠️ Please enter a valid season number!');
        return;
      }
      data.currentSeason = { seasonNumber, episodes: [] };
      userStates.set(chatId, 'adding_episode_number');
      bot.sendMessage(chatId, `📺 Season ${seasonNumber} - Enter episode number (or "next" for new season, "done" to finish):`);
      break;
    
    case 'adding_episode_number':
      if (text.toLowerCase() === 'next') {
        if (data.currentSeason.episodes.length === 0) {
          bot.sendMessage(chatId, '⚠️ Please add at least one episode to this season!');
          return;
        }
        data.seasons.push(data.currentSeason);
        userStates.set(chatId, 'adding_season_number');
        bot.sendMessage(chatId, '🔢 Enter next season number (or "done" to finish):');
        return;
      }
      if (text.toLowerCase() === 'done') {
        if (data.currentSeason && data.currentSeason.episodes.length > 0) {
          data.seasons.push(data.currentSeason);
        }
        if (data.seasons.length === 0) {
          bot.sendMessage(chatId, '⚠️ Please add at least one season with episodes!');
          return;
        }
        try {
          const series = new Series({ ...data, addedBy: userId });
          await series.save();
          bot.sendMessage(chatId, `✅ Series "${data.name}" with ${data.seasons.length} season(s) added successfully!`, {
            reply_markup: {
              keyboard: [['🎬 Add Movie', '📺 Add Series'], ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'], ['🌐 Open Frontend']],
              resize_keyboard: true
            }
          });
          userStates.delete(chatId);
          tempData.delete(chatId);
        } catch (error) {
          bot.sendMessage(chatId, '❌ Error adding series. Please try again.');
        }
        return;
      }
      const episodeNumber = parseInt(text);
      if (isNaN(episodeNumber) || episodeNumber <= 0) {
        bot.sendMessage(chatId, '⚠️ Please enter a valid episode number!');
        return;
      }
      data.currentEpisode = { episodeNumber };
      userStates.set(chatId, 'adding_episode_title');
      bot.sendMessage(chatId, `📺 S${data.currentSeason.seasonNumber}E${episodeNumber} - Enter episode title:`);
      break;

    case 'adding_episode_title':
      data.currentEpisode.title = text;
      userStates.set(chatId, 'adding_episode_url');
      bot.sendMessage(chatId, '🔗 Enter episode streaming URL:');
      break;

    case 'adding_episode_url':
      data.currentEpisode.streamingUrl = text;
      data.currentSeason.episodes.push(data.currentEpisode);
      bot.sendMessage(chatId, `✅ Episode added! S${data.currentSeason.seasonNumber}E${data.currentEpisode.episodeNumber}: ${data.currentEpisode.title}\n\n📺 Enter next episode number (or "next" for new season, "done" to finish):`);
      userStates.set(chatId, 'adding_episode_number');
      break;

    default:
      // Ignore messages that don't match any state to avoid spamming the user
      // with "Please use the menu options..."
      break;
  }
  tempData.set(chatId, data);
}

// ================================================================
// API ENDPOINTS
// ================================================================

// Endpoint to fetch all movies
app.get('/api/movies', async (req, res) => {
  try {
    const movies = await Movie.find().sort({ addedAt: -1 });
    res.json(movies);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

// Endpoint to fetch all series
app.get('/api/series', async (req, res) => {
  try {
    const series = await Series.find().sort({ addedAt: -1 });
    res.json(series);
  } catch (error) {
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
    res.status(500).json({ error: 'Failed to fetch series details' });
  }
});

// ================================================================
// WEBHOOK SETUP & SERVER START
// ================================================================

// This endpoint listens for incoming updates from Telegram
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server and set the webhook
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend available at: http://localhost:${PORT}`);
  // Set the webhook. On Koyeb, the host is automatically determined.
  const webhookUrl = `https://<YOUR_KOYEB_APP_URL>${webhookPath}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`Webhook set to: ${webhookUrl}`);
    console.log('Telegram Bot started via webhook...');
    console.log('Use /start in your bot to begin.');
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
});

