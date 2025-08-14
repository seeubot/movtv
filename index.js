// This file contains the main logic for the Telegram bot and Express API with APK generation.

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// NEW: APK Generation dependencies
const archiver = require('archiver');
const fsExtra = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

// ================================================================
// CONFIGURATION
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 1024;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
// FIX: Use the provided Koyeb URL for the frontend.
const KOYEB_URL = 'https://future-ester-seeutech-645c6129.koyeb.app';
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not found in environment variables. Please set it.');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables. Please set it.');
  process.exit(1);
}
if (USE_WEBHOOK && !KOYEB_URL) {
  console.error('❌ FRONTEND_URL (KOYEB_URL) is required for webhook mode. Please set it.');
  process.exit(1);
}

let bot;
if (USE_WEBHOOK) {
  bot = new TelegramBot(BOT_TOKEN, { onlyFirstMatch: true });
  console.log('🤖 Bot initialized for Webhook mode. Waiting for Express to start...');
} else {
  // Use polling for local development. On a platform like Koyeb, webhook mode is recommended.
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

movieSchema.index({ name: 'text' });
seriesSchema.index({ name: 'text' });

const Movie = mongoose.model('Movie', movieSchema);
const Series = mongoose.model('Series', seriesSchema);

// ================================================================
// EXPRESS APP & MIDDLEWARE
// ================================================================

const app = express();

// FIX: Update CORS to explicitly allow the Koyeb frontend URL.
// The wildcard '*' can sometimes be problematic with credentials,
// so it's best to be explicit about the origins.
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  KOYEB_URL // Add the Koyeb frontend URL
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

// Simplified error handling to avoid restart loops
bot.on('polling_error', (error) => {
  console.error('❌ Telegram polling error:', error.code, error.message);
});

bot.on('webhook_error', (error) => {
  console.error('❌ Telegram webhook error:', error);
});

// UPDATED: Main menu with APK generation option
const getMainMenuKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['🎬 Add Movie', '📺 Add Series'],
      ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
      ['🌐 Frontend URL', '📱 Generate APK'],
      ['📊 Library Stats']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
});

// Helper function to extract IDs safely
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
        '🎭 *Welcome to MovTV Manager Bot!*\n\n' +
        '🎬 Add and manage your movies\n' +
        '📺 Create and organize TV series\n' +
        '🌐 Access your media library via web frontend\n' +
        '📱 Generate Android APK for mobile access\n\n' +
        'Choose an option below:',
        { ...getMainMenuKeyboard(), parse_mode: 'Markdown' }
      );
    } else if (text === '🎬 Add Movie') {
      userStates.set(chatId, 'adding_movie_name');
      tempData.set(chatId, { type: 'movie' });
      await bot.sendMessage(chatId, '🎬 Enter the movie name:', { reply_markup: { remove_keyboard: true } });
    } else if (text === '📺 Add Series') {
      const seriesList = await Series.find({}, 'name').limit(20);
      if (seriesList.length > 0) {
        const seriesKeyboard = seriesList.map(s => [{ text: s.name, callback_data: `add_new_season_to_series_${s._id}` }]);
        seriesKeyboard.push([{ text: '➕ Create New Series', callback_data: 'create_new_series' }]);
        await bot.sendMessage(chatId, '📺 Choose a series to add seasons/episodes to, or create a new one:', {
          reply_markup: { inline_keyboard: seriesKeyboard }
        });
      } else {
        userStates.set(chatId, 'adding_series_name');
        tempData.set(chatId, { type: 'series' });
        await bot.sendMessage(chatId, '📺 Enter the new series name:', { reply_markup: { remove_keyboard: true } });
      }
    } else if (text === '✍️ Edit/Delete Movies') {
      const movies = await Movie.find().sort({ addedAt: -1 }).limit(10);
      if (movies.length === 0) {
        await bot.sendMessage(chatId, '📽️ No movies found! Add some first.', getMainMenuKeyboard());
      } else {
        const movieKeyboard = movies.map(movie => [
          { text: `✍️ ${movie.name}`, callback_data: `edit_movie_${movie._id}` },
          { text: `🗑️ ${movie.name}`, callback_data: `delete_movie_${movie._id}` }
        ]);
        await bot.sendMessage(chatId, '🎬 *Select a movie to edit or delete:*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: movieKeyboard }
        });
      }
    } else if (text === '🗑️ Edit/Delete Series') {
      const seriesList = await Series.find().sort({ addedAt: -1 }).limit(10);
      if (seriesList.length === 0) {
        await bot.sendMessage(chatId, '📺 No series found! Add some first.', getMainMenuKeyboard());
      } else {
        const seriesKeyboard = seriesList.map(series => [
          { text: `✍️ ${series.name}`, callback_data: `edit_series_${series._id}` },
          { text: `🗑️ ${series.name}`, callback_data: `delete_series_${series._id}` }
        ]);
        await bot.sendMessage(chatId, '📺 *Select a series to edit or delete:*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: seriesKeyboard }
        });
      }
    } else if (text === '🌐 Frontend URL') {
      const frontendUrl = KOYEB_URL || 'http://localhost:3000';
      await bot.sendMessage(chatId,
        `🌐 *Web Frontend:*\n${frontendUrl}\n\n` +
        `📱 *API Server:* ${frontendUrl}/api\n\n` +
        '🎬 Open the frontend URL to watch your movies and series!\n\n' +
        '✨ Your media library awaits!',
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
      );
    } else if (text === '📱 Generate APK') {
      const apkUrl = `${KOYEB_URL}/apk-generator.html`;
      await bot.sendMessage(chatId,
        '📱 *APK Generator*\n\n' +
        '🔗 Create your custom Android app:\n' +
        apkUrl + '\n\n' +
        '✨ Build a native Android app for your MovTV library!\n\n' +
        '📋 *Features:*\n' +
        '• Native WebView interface\n' +
        '• Internet connectivity check\n' +
        '• Loading progress indicator\n' +
        '• Back button navigation\n' +
        '• Offline error handling\n\n' +
        '🛠️ *Build Options:*\n' +
        '• Sketchware (recommended)\n' +
        '• Android Studio\n' +
        '• Online APK builders',
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
      );
    } else if (text === '📊 Library Stats') {
      const movieCount = await Movie.countDocuments();
      const seriesCount = await Series.countDocuments();
      const totalEpisodes = await Series.aggregate([
        { $unwind: '$seasons' },
        { $unwind: '$seasons.episodes' },
        { $count: 'totalEpisodes' }
      ]);
      const episodeCount = totalEpisodes[0]?.totalEpisodes || 0;

      await bot.sendMessage(chatId,
        `📊 *Library Statistics:*\n\n` +
        `🎬 Movies: ${movieCount}\n` +
        `📺 TV Series: ${seriesCount}\n` +
        `📹 Total Episodes: ${episodeCount}\n` +
        `🎭 Total Items: ${movieCount + seriesCount}`,
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

  console.log(`🔘 Callback query: ${data}`);

  try {
    // FIX: Reordered the if/else if checks to handle more specific cases first.
    if (data.startsWith('add_new_season_to_series_')) {
      const seriesId = extractId(data, 'add_new_season_to_series_');
      const series = await Series.findById(seriesId);
      if (series) {
        tempData.set(chatId, {
          type: 'series',
          seriesId: seriesId,
          name: series.name,
          thumbnail: series.thumbnail,
          seasons: [...series.seasons]
        });
        userStates.set(chatId, 'adding_season_number_for_existing_series');
        await bot.sendMessage(chatId, `📺 Adding to "${series.name}"\n\n🔢 Enter the new season number:`, { reply_markup: { remove_keyboard: true } });
      }
    } else if (data.startsWith('edit_series_episodes_')) {
      const seriesId = data.split('_').pop();
      const series = await Series.findById(seriesId);
      if (!series) {
        await bot.sendMessage(chatId, '❌ Series not found. Please try again.', getMainMenuKeyboard());
        return;
      }
      tempData.set(chatId, {
        type: 'series',
        seriesId: seriesId,
        name: series.name,
        thumbnail: series.thumbnail,
        seasons: series.seasons,
      });

      let keyboard = [];
      if (series.seasons && series.seasons.length > 0) {
        keyboard = series.seasons.map(s => [
          { text: `Season ${s.seasonNumber}`, callback_data: `select_season_${seriesId}_${s.seasonNumber}` }
        ]);
      }
      keyboard.push([{ text: '➕ Add New Season', callback_data: `add_new_season_to_series_${seriesId}` }]);

      await bot.sendMessage(chatId, '📺 *Select a season to add episodes to, or add a new season:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else if (data === 'create_new_series') {
      userStates.set(chatId, 'adding_series_name');
      tempData.set(chatId, { type: 'series' });
      await bot.sendMessage(chatId, '📺 Enter the new series name:', { reply_markup: { remove_keyboard: true } });
    } else if (data.startsWith('delete_movie_')) {
      const movieId = extractId(data, 'delete_movie_');
      const deletedMovie = await Movie.findByIdAndDelete(movieId);
      if (deletedMovie) {
        await bot.sendMessage(chatId, `✅ Movie "${deletedMovie.name}" deleted successfully!`, getMainMenuKeyboard());
      } else {
        await bot.sendMessage(chatId, '❌ Movie not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('delete_series_')) {
      const seriesId = extractId(data, 'delete_series_');
      const deletedSeries = await Series.findByIdAndDelete(seriesId);
      if (deletedSeries) {
        await bot.sendMessage(chatId, `✅ Series "${deletedSeries.name}" deleted successfully!`, getMainMenuKeyboard());
      } else {
        await bot.sendMessage(chatId, '❌ Series not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('edit_movie_')) {
      const movieId = extractId(data, 'edit_movie_');
      const movie = await Movie.findById(movieId);
      if (movie) {
        tempData.set(chatId, { type: 'movie', movieId, ...movie._doc });
        userStates.set(chatId, 'editing_movie');
        await bot.sendMessage(chatId,
          `🎬 *Editing Movie: ${movie.name}*\n\n` +
          `What would you like to edit?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✍️ Edit Name', callback_data: `edit_field_movie_name` }],
                [{ text: '📸 Edit Thumbnail URL', callback_data: `edit_field_movie_thumbnail` }],
                [{ text: '🔗 Edit Streaming URL', callback_data: `edit_field_movie_streaming_url` }],
                [{ text: '❌ Cancel', callback_data: 'cancel' }]
              ]
            }
          }
        );
      } else {
        await bot.sendMessage(chatId, '❌ Movie not found.', getMainMenuKeyboard());
      }
    // FIX: Moved this check to come after the more specific 'edit_series_episodes_' check.
    } else if (data.startsWith('edit_series_')) {
      const seriesId = extractId(data, 'edit_series_');
      const series = await Series.findById(seriesId);
      if (series) {
        tempData.set(chatId, { type: 'series', seriesId, ...series._doc });
        userStates.set(chatId, 'editing_series');
        await bot.sendMessage(chatId,
          `📺 *Editing Series: ${series.name}*\n\n` +
          `What would you like to edit?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✍️ Edit Name', callback_data: `edit_field_series_name` }],
                [{ text: '📸 Edit Thumbnail URL', callback_data: `edit_field_series_thumbnail` }],
                [{ text: '➕ Add/Edit Episodes', callback_data: `edit_series_episodes_${series._id}` }],
                [{ text: '❌ Cancel', callback_data: 'cancel' }]
              ]
            }
          }
        );
      } else {
        await bot.sendMessage(chatId, '❌ Series not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('edit_field_movie_')) {
        const userData = tempData.get(chatId);
        if (!userData || userData.type !== 'movie' || !userData.movieId) {
          await bot.sendMessage(chatId, '❌ No movie selected for editing. Please try again.', getMainMenuKeyboard());
          return;
        }
        const fieldToEdit = extractId(data, 'edit_field_movie_');
        switch (fieldToEdit) {
          case 'name':
            userStates.set(chatId, 'editing_movie_name');
            await bot.sendMessage(chatId, '✍️ Enter the new movie name:');
            break;
          case 'thumbnail':
            userStates.set(chatId, 'editing_movie_thumbnail');
            await bot.sendMessage(chatId, '📸 Enter the new movie thumbnail URL:');
            break;
          case 'streaming_url':
            userStates.set(chatId, 'editing_movie_streaming_url');
            await bot.sendMessage(chatId, '🔗 Enter the new streaming URL:');
            break;
          default:
            await bot.sendMessage(chatId, '❌ Invalid edit option.', getMainMenuKeyboard());
            break;
        }
    } else if (data.startsWith('edit_field_series_')) {
        const userData = tempData.get(chatId);
        if (!userData || userData.type !== 'series' || !userData.seriesId) {
          await bot.sendMessage(chatId, '❌ No series selected for editing. Please try again.', getMainMenuKeyboard());
          return;
        }
        const fieldToEdit = extractId(data, 'edit_field_series_');
        switch (fieldToEdit) {
          case 'name':
            userStates.set(chatId, 'editing_series_name');
            await bot.sendMessage(chatId, '✍️ Enter the new series name:');
            break;
          case 'thumbnail':
            userStates.set(chatId, 'editing_series_thumbnail');
            await bot.sendMessage(chatId, '📸 Enter the new series thumbnail URL:');
            break;
          default:
            await bot.sendMessage(chatId, '❌ Invalid edit option.', getMainMenuKeyboard());
            break;
        }
    } else if (data.startsWith('select_season_')) {
        const parts = data.split('_');
        const seriesId = parts[2];
        const seasonNumber = parseInt(parts[3]);

        const series = await Series.findById(seriesId);
        if (!series) {
          await bot.sendMessage(chatId, '❌ Series not found. Please try again.', getMainMenuKeyboard());
          return;
        }
        const selectedSeason = series.seasons.find(s => s.seasonNumber === seasonNumber);
        if (!selectedSeason) {
            await bot.sendMessage(chatId, '❌ Season not found. Please try again.', getMainMenuKeyboard());
            return;
        }
        tempData.set(chatId, {
            type: 'series',
            seriesId: seriesId,
            name: series.name,
            thumbnail: series.thumbnail,
            seasons: series.seasons,
            currentSeason: selectedSeason
        });

        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Adding to Series "${series.name}", Season ${seasonNumber}.\n\n🔢 Enter episode number:`, { reply_markup: { remove_keyboard: true } });
    } else if (data === 'add_another_episode') {
      const userData = tempData.get(chatId);
      if (userData && userData.currentSeason) {
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Season ${userData.currentSeason.seasonNumber} - Enter next episode number:`);
      } else {
        await bot.sendMessage(chatId, '❌ No series or season in progress. Please start over.', getMainMenuKeyboard());
        userStates.delete(chatId);
        tempData.delete(chatId);
      }
    } else if (data === 'add_new_season') {
      userStates.set(chatId, 'adding_season_number');
      await bot.sendMessage(chatId, '🔢 Enter new season number:');
    } else if (data === 'finish_series') {
      const userData = tempData.get(chatId);
      if (!userData || userData.type !== 'series') {
          await bot.sendMessage(chatId, '❌ No series in progress. Please start over.', getMainMenuKeyboard());
          userStates.delete(chatId);
          tempData.delete(chatId);
          return;
      }
      try {
        if (userData.seriesId) {
          await Series.findByIdAndUpdate(userData.seriesId, { seasons: userData.seasons });
          await bot.sendMessage(chatId, `✅ Series "${userData.name}" updated successfully!`, getMainMenuKeyboard());
        } else {
          const series = new Series({
            name: userData.name,
            thumbnail: userData.thumbnail,
            seasons: userData.seasons,
            addedBy: callbackQuery.from.id
          });
          await series.save();
          await bot.sendMessage(chatId, `✅ Series "${userData.name}" created with ${userData.seasons.length} season(s)!`, getMainMenuKeyboard());
        }
      } catch (error) {
        console.error('Error saving series:', error);
        await bot.sendMessage(chatId, '❌ Error saving series. Please try again.', getMainMenuKeyboard());
      }
      userStates.delete(chatId);
      tempData.delete(chatId);
    } else if (data === 'cancel') {
        userStates.delete(chatId);
        tempData.delete(chatId);
        await bot.sendMessage(chatId, 'Operation canceled.', getMainMenuKeyboard());
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('❌ Error handling callback query:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred' });
    // Clear state on error to prevent being stuck
    userStates.delete(chatId);
    tempData.delete(chatId);
  }
});

async function handleConversationFlow(chatId, text, userId) {
  const state = userStates.get(chatId);
  const data = tempData.get(chatId) || {};
  try {
    switch (state) {
      case 'adding_movie_name':
        data.name = text.trim();
        userStates.set(chatId, 'adding_movie_thumbnail');
        await bot.sendMessage(chatId, '📸 Enter the movie thumbnail URL (image):');
        break;
      case 'adding_movie_thumbnail':
        data.thumbnail = text.trim();
        userStates.set(chatId, 'adding_movie_streaming_url');
        await bot.sendMessage(chatId, '🔗 Enter the streaming URL (.mp4, .m3u8, etc.):');
        break;
      case 'adding_movie_streaming_url':
        data.streamingUrl = text.trim();
        try {
          const movie = new Movie({ ...data, addedBy: userId });
          await movie.save();
          await bot.sendMessage(chatId, `✅ Movie "${data.name}" added successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error saving movie:', error);
          await bot.sendMessage(chatId, '❌ Error adding movie. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'adding_series_name':
        data.name = text.trim();
        userStates.set(chatId, 'adding_series_thumbnail');
        await bot.sendMessage(chatId, '📸 Enter the series thumbnail URL (image):');
        break;
      case 'adding_series_thumbnail':
        data.thumbnail = text.trim();
        data.seasons = [];
        userStates.set(chatId, 'adding_season_number');
        await bot.sendMessage(chatId, '🔢 Enter season number:');
        break;
      case 'adding_season_number_for_existing_series':
      case 'adding_season_number':
        const seasonNumber = parseInt(text.trim());
        if (isNaN(seasonNumber) || seasonNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid season number!');
          return;
        }
        const existingSeason = data.seasons.find(s => s.seasonNumber === seasonNumber);
        if (existingSeason) {
          await bot.sendMessage(chatId, '⚠️ This season already exists. Please enter a different season number.');
          return;
        }
        data.currentSeason = { seasonNumber, episodes: [] };
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Season ${seasonNumber} - Enter episode number:`);
        break;
      case 'adding_episode_number':
        const episodeNumber = parseInt(text.trim());
        if (isNaN(episodeNumber) || episodeNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid episode number!');
          return;
        }
        const existingEpisode = data.currentSeason.episodes.find(e => e.episodeNumber === episodeNumber);
        if (existingEpisode) {
          await bot.sendMessage(chatId, `⚠️ Episode ${episodeNumber} already exists in Season ${data.currentSeason.seasonNumber}. Choose a different number.`);
          return;
        }
        data.currentEpisode = { episodeNumber };
        userStates.set(chatId, `adding_episode_title`);
        await bot.sendMessage(chatId, `📺 S${data.currentSeason.seasonNumber}E${episodeNumber} - Enter episode title:`);
        break;
      case 'adding_episode_title':
        data.currentEpisode.title = text.trim();
        userStates.set(chatId, `adding_episode_url`);
        await bot.sendMessage(chatId, '🔗 Enter episode streaming URL:');
        break;
      case 'adding_episode_url':
        data.currentEpisode.streamingUrl = text.trim();
        data.currentSeason.episodes.push(data.currentEpisode);
        const seasonIndex = data.seasons.findIndex(s => s.seasonNumber === data.currentSeason.seasonNumber);
        if (seasonIndex >= 0) {
          data.seasons[seasonIndex] = data.currentSeason;
        } else {
          data.seasons.push(data.currentSeason);
        }
        const totalEpisodes = data.currentSeason.episodes.length;
        await bot.sendMessage(chatId,
          `✅ Episode added! S${data.currentSeason.seasonNumber}E${data.currentEpisode.episodeNumber}: ${data.currentEpisode.title}\n\n` +
          `📊 Season ${data.currentSeason.seasonNumber} now has ${totalEpisodes} episode${totalEpisodes !== 1 ? 's' : ''}\n\n` +
          `What would you like to do next?`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '➕ Add Another Episode', callback_data: 'add_another_episode' }],
                [{ text: '🔢 Add New Season', callback_data: `add_new_season_to_series_${data.seriesId}` }],
                [{ text: '✅ Finish Series', callback_data: 'finish_series' }]
              ]
            }
          }
        );
        break;
      case 'editing_movie_name':
        try {
          await Movie.findByIdAndUpdate(data.movieId, { name: text.trim() });
          await bot.sendMessage(chatId, `✅ Movie name updated to "${text.trim()}"!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating movie name:', error);
          await bot.sendMessage(chatId, '❌ Error updating movie name. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_movie_thumbnail':
        try {
          await Movie.findByIdAndUpdate(data.movieId, { thumbnail: text.trim() });
          await bot.sendMessage(chatId, `✅ Movie thumbnail updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating movie thumbnail:', error);
          await bot.sendMessage(chatId, '❌ Error updating movie thumbnail. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_movie_streaming_url':
        try {
          await Movie.findByIdAndUpdate(data.movieId, { streamingUrl: text.trim() });
          await bot.sendMessage(chatId, `✅ Movie streaming URL updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating movie streaming URL:', error);
          await bot.sendMessage(chatId, '❌ Error updating movie streaming URL. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_series_name':
        try {
          await Series.findByIdAndUpdate(data.seriesId, { name: text.trim() });
          await bot.sendMessage(chatId, `✅ Series name updated to "${text.trim()}"!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating series name:', error);
          await bot.sendMessage(chatId, '❌ Error updating series name. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_series_thumbnail':
        try {
          await Series.findByIdAndUpdate(data.seriesId, { thumbnail: text.trim() });
          await bot.sendMessage(chatId, `✅ Series thumbnail updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating series thumbnail:', error);
          await bot.sendMessage(chatId, '❌ Error updating series thumbnail. Please try again.', getMainMenuKeyboard());
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

app.get('/api/movies', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const query = search ? { name: { $regex: search, $options: 'i' } } : {};
    const movies = await Movie.find(query)
      .sort({ addedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    const total = await Movie.countDocuments(query);
    if (movies.length === 0) {
      return res.json([]);
    }
    res.json(movies);
  } catch (error) {
    console.error('❌ Error fetching movies:', error);
    res.status(500).json({ error: 'Failed to fetch movies', details: error.message });
  }
});

app.get('/api/series', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const query = search ? { name: { $regex: search, $options: 'i' } } : {};
    const series = await Series.find(query)
      .sort({ addedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    const total = await Series.countDocuments(query);
    if (series.length === 0) {
      return res.json([]);
    }
    res.json(series);
  } catch (error) {
    console.error('❌ Error fetching series:', error);
    res.status(500).json({ error: 'Failed to fetch series', details: error.message });
  }
});

app.get('/api/series/:id', async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    res.json(series);
  } catch (error) {
    console.error('❌ Error fetching series details:', error);
    res.status(500).json({ error: 'Failed to fetch series details', details: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const movieCount = await Movie.countDocuments();
    const seriesCount = await Series.countDocuments();
    const totalEpisodes = await Series.aggregate([
      { $unwind: '$seasons' },
      { $unwind: '$seasons.episodes' },
      { $count: 'totalEpisodes' }
    ]);
    const episodeCount = totalEpisodes[0]?.totalEpisodes || 0;
    res.json({
      movies: movieCount,
      series: seriesCount,
      episodes: episodeCount,
      total: movieCount + seriesCount
    });
  } catch (error) {
    console.error('❌ Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ================================================================
// APK GENERATION ENDPOINTS
// ================================================================

// Generate APK endpoint
app.post('/api/generate-apk', async (req, res) => {
  const { appName = 'MovTV', packageName = 'com.movtv.app', appIcon = null } = req.body;
  const generationId = uuidv4();
  
  console.log(`🔨 Starting APK generation for: ${appName}`);
  
  try {
    // Validate input
    if (!appName || appName.trim().length === 0) {
      return res.status(400).json({ error: 'App name is required' });
    }
    
    if (!packageName || !packageName.match(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)) {
      return res.status(400).json({ error: 'Invalid package name format' });
    }
    
    // Create temporary directory for this generation
    const tempDir = path.join(__dirname, 'temp-apk', generationId);
    await fsExtra.ensureDir(tempDir);
    
    // Generate Android project structure
    await generateAndroidProject(tempDir, appName, packageName, appIcon);
    
    // Create APK package (ZIP format for download)
    const apkFileName = `${appName.replace(/[^a-zA-Z0-9]/g, '')}_v${Date.now()}.zip`;
    const apkPath = path.join(__dirname, 'public', 'apks', apkFileName);
    await fsExtra.ensureDir(path.dirname(apkPath));
    
    await createAPKPackage(tempDir, apkPath);
    
    // Clean up temporary files
    await fsExtra.remove(tempDir);
    
    // Log generation success
    console.log(`✅ APK generated successfully: ${apkFileName}`);
    
    res.json({
      success: true,
      generationId,
      appName,
      packageName,
      fileName: apkFileName,
      downloadUrl: `${KOYEB_URL}/apks/${apkFileName}`,
      size: (await fsExtra.stat(apkPath)).size,
      createdAt: new Date().toISOString(),
      instructions: {
        install: [
          '1. Download the ZIP file',
          '2. Extract the contents',
          '3. Install Android Studio or use online APK builders',
          '4. Import the project and build APK',
          '5. Or use the provided Sketchware import file'
        ]
      }
    });
    
  } catch (error) {
    console.error('❌ APK generation failed:', error);
    
    // Clean up on error
    try {
      const tempDir = path.join(__dirname, 'temp-apk', generationId);
      await fsExtra.remove(tempDir);
    } catch (cleanupError) {
      console.error('❌ Cleanup error:', cleanupError);
    }
    
    res.status(500).json({ 
      error: 'APK generation failed', 
      details: error.message,
      generationId 
    });
  }
});

// Get APK generation status
app.get('/api/apk-status/:generationId', async (req, res) => {
  const { generationId } = req.params;
  const tempDir = path.join(__dirname, 'temp-apk', generationId);
  
  try {
    const exists = await fsExtra.pathExists(tempDir);
    res.json({
      generationId,
      status: exists ? 'processing' : 'completed',
      message: exists ? 'APK generation in progress' : 'Generation completed or not found'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// List generated APKs
app.get('/api/generated-apks', async (req, res) => {
  try {
    const apkDir = path.join(__dirname, 'public', 'apks');
    await fsExtra.ensureDir(apkDir);
    
    const files = await fsExtra.readdir(apkDir);
    const apkFiles = files.filter(file => file.endsWith('.zip'));
    
    const apkList = await Promise.all(
      apkFiles.map(async (file) => {
        const filePath = path.join(apkDir, file);
        const stats = await fsExtra.stat(filePath);
        return {
          fileName: file,
          downloadUrl: `${KOYEB_URL}/apks/${file}`,
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
    );
    
    res.json({
      success: true,
      count: apkList.length,
      apks: apkList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
    
  } catch (error) {
    console.error('❌ Error listing APKs:', error);
    res.status(500).json({ error: 'Failed to list APKs' });
  }
});

// Delete generated APK
app.delete('/api/generated-apks/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = path.join(__dirname, 'public', 'apks', fileName);
    
    if (!fileName.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid file name' });
    }
    
    await fsExtra.remove(filePath);
    res.json({ success: true, message: 'APK deleted successfully' });
    
  } catch (error) {
    console.error('❌ Error deleting APK:', error);
    res.status(500).json({ error: 'Failed to delete APK' });
  }
});

// Serve APK files
app.use('/apks', express.static(path.join(__dirname, 'public', 'apks')));

// ================================================================
// APK GENERATION HELPER FUNCTIONS
// ================================================================

async function generateAndroidProject(tempDir, appName, packageName, appIcon) {
  console.log(`📁 Generating Android project structure...`);
  
  // Create directory structure
  const srcDir = path.join(tempDir, 'src', 'main');
  const javaDir = path.join(srcDir, 'java', ...packageName.split('.'));
  const resDir = path.join(srcDir, 'res');
  const assetsDir = path.join(srcDir, 'assets');
  
  await fsExtra.ensureDir(javaDir);
  await fsExtra.ensureDir(path.join(resDir, 'layout'));
  await fsExtra.ensureDir(path.join(resDir, 'values'));
  await fsExtra.ensureDir(path.join(resDir, 'mipmap-hdpi'));
  await fsExtra.ensureDir(path.join(resDir, 'drawable'));
  await fsExtra.ensureDir(assetsDir);
  
  // Generate AndroidManifest.xml
  const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}"
    android:versionCode="1"
    android:versionName="1.0">
    
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
    
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="${appName}"
        android:theme="@style/AppTheme"
        android:hardwareAccelerated="true"
        android:usesCleartextTraffic="true">
        
        <activity 
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="portrait"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
            
    </application>
</manifest>`;

  await fsExtra.writeFile(path.join(srcDir, 'AndroidManifest.xml'), manifestContent);
  
  // Generate MainActivity.java
  const mainActivityContent = `package ${packageName};

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView webView;
    private ProgressBar progressBar;
    private static final String URL = "${KOYEB_URL}";
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        
        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progressBar);
        
        setupWebView();
        
        if (isNetworkAvailable()) {
            loadWebsite();
        } else {
            showNoInternetDialog();
        }
    }
    
    private void setupWebView() {
        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setLoadWithOverviewMode(true);
        webSettings.setUseWideViewPort(true);
        webSettings.setBuiltInZoomControls(false);
        webSettings.setDisplayZoomControls(false);
        webSettings.setSupportZoom(false);
        webSettings.setDefaultTextEncodingName("utf-8");
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webSettings.setAllowFileAccess(true);
        webSettings.setAllowContentAccess(true);
        
        // Enable mixed content for HTTPS sites with HTTP resources
        webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
            }
            
            @Override
            public void onReceivedError(WebView view, int errorCode, 
                    String description, String failingUrl) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                progressBar.setVisibility(View.GONE);
                Toast.makeText(MainActivity.this, "Network Error: " + description, 
                    Toast.LENGTH_LONG).show();
                showRetryDialog();
            }
        });
        
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (progress == 100) {
                    progressBar.setVisibility(View.GONE);
                } else {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(progress);
                }
            }
        });
    }
    
    private void loadWebsite() {
        progressBar.setVisibility(View.VISIBLE);
        webView.loadUrl(URL);
    }
    
    private boolean isNetworkAvailable() {
        ConnectivityManager connectivityManager = 
            (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo activeNetworkInfo = connectivityManager.getActiveNetworkInfo();
        return activeNetworkInfo != null && activeNetworkInfo.isConnected();
    }
    
    private void showNoInternetDialog() {
        new AlertDialog.Builder(this)
            .setTitle("No Internet Connection")
            .setMessage("${appName} requires an internet connection to work. Please check your connection and try again.")
            .setPositiveButton("Retry", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    if (isNetworkAvailable()) {
                        loadWebsite();
                    } else {
                        showNoInternetDialog();
                    }
                }
            })
            .setNegativeButton("Exit", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    finish();
                }
            })
            .setCancelable(false)
            .show();
    }
    
    private void showRetryDialog() {
        new AlertDialog.Builder(this)
            .setTitle("Connection Error")
            .setMessage("Unable to load ${appName}. Would you like to retry?")
            .setPositiveButton("Retry", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    loadWebsite();
                }
            })
            .setNegativeButton("Exit", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    finish();
                }
            })
            .show();
    }
    
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            new AlertDialog.Builder(this)
                .setTitle("Exit ${appName}")
                .setMessage("Are you sure you want to exit?")
                .setPositiveButton("Yes", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        MainActivity.super.onBackPressed();
                    }
                })
                .setNegativeButton("No", null)
                .show();
        }
    }
    
    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }
    
    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }
}`;

  await fsExtra.writeFile(path.join(javaDir, 'MainActivity.java'), mainActivityContent);
  
  // Generate layout file
  const layoutContent = `<?xml version="1.0" encoding="utf-8"?>
<RelativeLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@android:color/white">

    <WebView
        android:id="@+id/webview"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

    <ProgressBar
        android:id="@+id/progressBar"
        style="?android:attr/progressBarStyleHorizontal"
        android:layout_width="match_parent"
        android:layout_height="6dp"
        android:layout_alignParentTop="true"
        android:progressDrawable="@drawable/progress_bar"
        android:visibility="gone"
        android:max="100" />

</RelativeLayout>`;

  await fsExtra.writeFile(path.join(resDir, 'layout', 'activity_main.xml'), layoutContent);
  
  // Generate styles.xml
  const stylesContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="android:Theme.Light.NoTitleBar">
        <item name="android:windowBackground">@android:color/white</item>
        <item name="android:colorPrimary">@color/colorPrimary</item>
        <item name="android:colorAccent">@color/colorAccent</item>
    </style>
</resources>`;

  await fsExtra.writeFile(path.join(resDir, 'values', 'styles.xml'), stylesContent);
  
  // Generate strings.xml
  const stringsContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${appName}</string>
</resources>`;

  await fsExtra.writeFile(path.join(resDir, 'values', 'strings.xml'), stringsContent);
  
  // Generate colors.xml
  const colorsContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#667eea</color>
    <color name="colorPrimaryDark">#5a6fd8</color>
    <color name="colorAccent">#764ba2</color>
    <color name="progressColor">#4facfe</color>
</resources>`;

  await fsExtra.writeFile(path.join(resDir, 'values', 'colors.xml'), colorsContent);
  
  // Generate progress bar drawable
  const progressBarContent = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@android:id/background">
        <shape>
            <solid android:color="#E0E0E0"/>
            <corners android:radius="3dp"/>
        </shape>
    </item>
    <item android:id="@android:id/progress">
        <clip>
            <shape>
                <solid android:color="@color/progressColor"/>
                <corners android:radius="3dp"/>
            </shape>
        </clip>
    </item>
</layer-list>`;

  await fsExtra.writeFile(path.join(resDir, 'drawable', 'progress_bar.xml'), progressBarContent);
  
  // Generate build.gradle
  const gradleContent = `apply plugin: 'com.android.application'

android {
    compileSdkVersion 33
    buildToolsVersion "33.0.0"
    
    defaultConfig {
        applicationId "${packageName}"
        minSdkVersion 21
        targetSdkVersion 33
        versionCode 1
        versionName "1.0"
        
        testInstrumentationRunner "android.support.test.runner.AndroidJUnitRunner"
    }
    
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation 'com.android.support:appcompat-v7:28.0.0'
    implementation 'com.android.support.constraint:constraint-layout:1.1.3'
    testImplementation 'junit:junit:4.12'
    androidTestImplementation 'com.android.support.test:runner:1.0.2'
    androidTestImplementation 'com.android.support.test.espresso:espresso-core:3.0.2'
}`;

  await fsExtra.writeFile(path.join(tempDir, 'build.gradle'), gradleContent);
  
  // Generate proguard rules
  const proguardContent = `# Add project specific ProGuard rules here.
-keep class android.webkit.** { *; }
-dontwarn android.webkit.**
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}`;

  await fsExtra.writeFile(path.join(tempDir, 'proguard-rules.pro'), proguardContent);
  
  // Generate Sketchware config
  const sketchwareConfig = {
    projectName: appName,
    packageName: packageName,
    webviewUrl: KOYEB_URL,
    appDescription: `${appName} - Movie and TV Series Manager`,
    targetSdk: 33,
    minSdk: 21,
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE'],
    features: [
      'WebView with JavaScript enabled',
      'Internet connectivity check',
      'Loading progress indicator', 
      'Back button navigation',
      'Error handling and retry',
      'Exit confirmation dialog'
    ],
    instructions: [
      '1. Open Sketchware on your Android device',
      '2. Create new project with package name: ' + packageName,
      '3. Add WebView component and set these properties:',
      '   - URL: ' + KOYEB_URL,
      '   - Enable JavaScript: true',
      '   - Enable DOM Storage: true',
      '4. Add ProgressBar for loading indication',
      '5. Add internet permission in AndroidManifest',
      '6. Implement back button handling',
      '7. Build APK and install on device'
    ]
  };
  
  await fsExtra.writeFile(path.join(tempDir, 'sketchware_config.json'), JSON.stringify(sketchwareConfig, null, 2));
  
  // Generate comprehensive README
  const readmeContent = `# ${appName} - Android App Package

**Generated on:** ${new Date().toLocaleString()}
**Target URL:** ${KOYEB_URL}

## 📱 Project Information

- **App Name:** ${appName}
- **Package Name:** ${packageName}
- **Target SDK:** 33 (Android 13)
- **Minimum SDK:** 21 (Android 5.0)
- **App Type:** WebView-based native Android app

## 🚀 Building Instructions

### Option 1: Sketchware (Recommended for Beginners)

1. **Download Sketchware** from Google Play Store
2. **Create New Project:**
   - Project Name: ${appName}
   - Package Name: \`${packageName}\`
   - App Name: ${appName}

3. **Add Components:**
   - Add WebView component (fill screen)
   - Add ProgressBar (horizontal, at top)

4. **Configure WebView:**
   - Set URL: \`${KOYEB_URL}\`
   - Enable JavaScript: ✅
   - Enable DOM Storage: ✅

5. **Add Permissions:**
   - INTERNET
   - ACCESS_NETWORK_STATE
   - ACCESS_WIFI_STATE

6. **Build APK** directly in Sketchware

### Option 2: Android Studio (Professional)

1. **Import Project:**
   - Open Android Studio
   - Import this extracted project folder
   - Wait for Gradle sync

2. **Build APK:**
   - Go to Build > Build Bundle(s)/APK(s) > Build APK(s)
   - Wait for build completion
   - APK will be in \`app/build/outputs/apk/\`

### Option 3: Online APK Builders

1. **Upload Project:** 
   - Visit online builders like:
     - BuildAPKOnline.com
     - ApkOnline.com
     - AndroidAPKsFree.com

2. **Upload this ZIP file**
3. **Configure build settings**
4. **Download generated APK**

## 📋 Features Included

✅ **Native WebView Interface** - Loads your MovTV web app
✅ **Internet Connectivity Check** - Detects network status
✅ **Loading Progress Indicator** - Shows loading progress
✅ **Back Button Navigation** - Proper navigation handling
✅ **Error Handling** - Network error recovery
✅ **Exit Confirmation** - Prevents accidental exits
✅ **Responsive Design** - Works on all screen sizes
✅ **Offline Detection** - Handles connection issues

## 🔧 Technical Details

### Permissions Required:
- **INTERNET** - Access to internet for loading content
- **ACCESS_NETWORK_STATE** - Check network connectivity
- **ACCESS_WIFI_STATE** - Monitor WiFi status
- **WRITE_EXTERNAL_STORAGE** - For caching (optional)

### Supported Android Versions:
- **Minimum:** Android 5.0 (API 21)
- **Target:** Android 13 (API 33)
- **Tested:** Android 6.0+ (API 23+)

### WebView Settings:
- JavaScript: Enabled
- DOM Storage: Enabled
- Mixed Content: Allowed
- Cache Mode: Default
- User Agent: Default WebView

## 📱 Installation Guide

### For End Users:

1. **Download APK** from the generated package
2. **Enable Unknown Sources:**
   - Go to Settings > Security
   - Enable "Install from Unknown Sources"
   - Or allow installation for specific browser

3. **Install APK:**
   - Tap on downloaded APK file
   - Follow installation prompts
   - Grant required permissions

4. **Launch App:**
   - Find ${appName} in app drawer
   - Tap to launch
   - App will load your MovTV library

## 🔍 Troubleshooting

### Common Issues:

**❌ App won't install:**
- Enable "Install from Unknown Sources"
- Check available storage space
- Try redownloading APK

**❌ White screen on launch:**
- Check internet connection
- Verify URL is accessible: ${KOYEB_URL}
- Clear app data and restart

**❌ App crashes on startup:**
- Update Android System WebView
- Clear app cache
- Restart device

**❌ Can't connect to server:**
- Check WiFi/mobile data
- Try opening URL in browser
- Contact server administrator

### Debug Information:
- **Server URL:** ${KOYEB_URL}
- **Generated:** ${new Date().toISOString()}
- **Package:** ${packageName}
- **Version:** 1.0 (Build 1)

## 🌐 Server Requirements

Your MovTV server should be:
- ✅ Accessible via HTTPS
- ✅ Responsive web design
- ✅ Mobile-friendly interface
- ✅ CORS enabled for mobile access

## 📞 Support

For technical support:
- **Backend Server:** ${KOYEB_URL}
- **API Endpoint:** ${KOYEB_URL}/api
- **Health Check:** ${KOYEB_URL}/health

## 🔄 Updates

To update your app:
1. Generate new APK with same package name
2. Install over existing app (data preserved)
3. Or uninstall old version first (data lost)

## 📄 License

This APK package is generated for personal use with your MovTV server.
Ensure you have proper rights to all media content accessed through the app.

---

**Enjoy your MovTV mobile experience! 🎬📱**
`;

  await fsExtra.writeFile(path.join(tempDir, 'README.md'), readmeContent);
  
  console.log(`✅ Android project structure generated successfully`);
}

async function createAPKPackage(sourceDir, outputPath) {
  console.log(`📦 Creating APK package...`);
  
  return new Promise((resolve, reject) => {
    const output = fsExtra.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    output.on('close', () => {
      console.log(`✅ APK package created: ${formatBytes(archive.pointer())}`);
      resolve();
    });
    
    archive.on('error', (err) => {
      console.error('❌ Archive error:', err);
      reject(err);
    });
    
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// Utility function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Cleanup old APK files (run every hour)
setInterval(async () => {
  try {
    const apkDir = path.join(__dirname, 'public', 'apks');
    await fsExtra.ensureDir(apkDir);
    const files = await fsExtra.readdir(apkDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const file of files) {
      if (!file.endsWith('.zip')) continue;
      
      const filePath = path.join(apkDir, file);
      const stats = await fsExtra.stat(filePath);
      
      if (now - stats.birthtimeMs > maxAge) {
        await fsExtra.remove(filePath);
        console.log(`🗑️ Cleaned up old APK: ${file}`);
      }
    }
  } catch (error) {
    console.error('❌ APK cleanup error:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Create required directories on startup
(async () => {
  try {
    await fsExtra.ensureDir(path.join(__dirname, 'public', 'apks'));
    await fsExtra.ensureDir(path.join(__dirname, 'temp-apk'));
    console.log('✅ APK directories ensured');
  } catch (error) {
    console.error('❌ Error creating APK directories:', error);
  }
})();

// ================================================================
// MAIN APP ROUTES
// ================================================================

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
    name: 'MovTV Manager API',
    version: '1.0.0',
    status: 'running',
    features: ['Movies', 'TV Series', 'APK Generation'],
    endpoints: {
      movies: '/api/movies',
      series: '/api/series',
      seriesById: '/api/series/:id',
      stats: '/api/stats',
      health: '/health',
      generateApk: '/api/generate-apk',
      listApks: '/api/generated-apks',
      apkStatus: '/api/apk-status/:generationId'
    },
    message: 'Frontend is available at the root URL /',
    apkGenerator: 'Available at /apk-generator.html'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: error.message,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found',
    path: req.path,
    timestamp: new Date().toISOString()
  });
});

// ================================================================
// SERVER STARTUP
// ================================================================

app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n🚀 ===== MovTV Manager Server Started =====');
  console.log(`📅 Started at: ${new Date().toLocaleString()}`);
  console.log(`🌐 Server running on port: ${PORT}`);
  console.log(`📱 API Base URL: ${KOYEB_URL ? `${KOYEB_URL}/api` : `http://localhost:${PORT}/api`}`);
  console.log(`🤖 Bot mode: ${USE_WEBHOOK ? 'Webhook' : 'Polling'}`);
  console.log(`📦 APK Generator: ${KOYEB_URL}/apk-generator.html`);

  if (USE_WEBHOOK && KOYEB_URL) {
    const webhookUrl = `${KOYEB_URL}${WEBHOOK_PATH}`;
    console.log(`\n🔗 Setting Telegram webhook to: ${webhookUrl}`);
    try {
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook set successfully!');
    } catch (e) {
      console.error('❌ Failed to set webhook:', e.message);
    }
  }

  console.log('\n📋 Available endpoints:');
  console.log('   📊 GET  /health         - Health check');
  console.log('   🎬 GET  /api/movies     - Get all movies');
  console.log('   📺 GET  /api/series     - Get all series');
  console.log('   🔍 GET  /api/series/:id - Get series details');
  console.log('   📈 GET  /api/stats      - Get library statistics');
  console.log('   📱 POST /api/generate-apk - Generate APK package');
  console.log('   📂 GET  /api/generated-apks - List generated APKs');
  console.log('   🗑️  DEL  /api/generated-apks/:fileName - Delete APK');
  console.log('   📥 GET  /apks/*         - Download APK files');
  
  console.log('\n🎯 Quick Links:');
  console.log(`   🌐 Frontend: ${KOYEB_URL || `http://localhost:${PORT}`}`);
  console.log(`   📱 APK Generator: ${KOYEB_URL}/apk-generator.html`);
  console.log(`   📊 API Info: ${KOYEB_URL}/api`);
  
  console.log('\n✅ MovTV Manager is ready! 🎬📺📱\n');
});

// ================================================================
// GRACEFUL SHUTDOWN HANDLERS
// ================================================================

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  try {
    if (!USE_WEBHOOK && bot) {
      bot.stopPolling();
      console.log('✅ Bot polling stopped');
    }
    
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    
    // Clean up temporary APK files
    try {
      const tempDir = path.join(__dirname, 'temp-apk');
      await fsExtra.remove(tempDir);
      console.log('✅ Temporary APK files cleaned up');
    } catch (cleanupError) {
      console.log('⚠️  Temp cleanup skipped:', cleanupError.message);
    }
    
    console.log('✅ MovTV Manager shutdown complete');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  try {
    if (!USE_WEBHOOK && bot) {
      bot.stopPolling();
      console.log('✅ Bot polling stopped');
    }
    
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    
    // Clean up temporary APK files
    try {
      const tempDir = path.join(__dirname, 'temp-apk');
      await fsExtra.remove(tempDir);
      console.log('✅ Temporary APK files cleaned up');
    } catch (cleanupError) {
      console.log('⚠️  Temp cleanup skipped:', cleanupError.message);
    }
    
    console.log('✅ MovTV Manager shutdown complete');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
