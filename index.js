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
if (USE_WEBHOOK && !KOYEB_URL) {
  console.error('❌ KOYEB_URL is required for webhook mode. Please set it.');
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

// ✨ UPDATED: Refactored schemas for better scalability
const movieSchema = new mongoose.Schema({
  name: { type: String, required: true },
  thumbnail: { type: String, required: true },
  streamingUrl: { type: String, required: true },
  addedBy: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now },
  type: { type: String, default: 'movie' }
});

const seriesSchema = new mongoose.Schema({
  name: { type: String, required: true },
  thumbnail: { type: String, required: true },
  addedBy: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now },
  type: { type: String, default: 'series' }
});

const episodeSchema = new mongoose.Schema({
  seriesId: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', required: true },
  seasonNumber: { type: Number, required: true },
  episodeNumber: { type: Number, required: true },
  title: { type: String, required: true },
  streamingUrl: { type: String, required: true },
  thumbnail: String,
  addedBy: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now }
});

movieSchema.index({ name: 'text' });
seriesSchema.index({ name: 'text' });
episodeSchema.index({ seriesId: 1, seasonNumber: 1, episodeNumber: 1 }, { unique: true });
episodeSchema.index({ title: 'text' });

const Movie = mongoose.model('Movie', movieSchema);
const Series = mongoose.model('Series', seriesSchema);
const Episode = mongoose.model('Episode', episodeSchema);

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
      ['🎬 Add Movie', '📺 Add Series'],
      ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
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
        '🎬 Add and manage your movies\n' +
        '📺 Create and organize TV series\n' +
        '🌐 Access your media library via web frontend\n\n' +
        'Choose an option below:',
        { ...getMainMenuKeyboard(), parse_mode: 'Markdown' }
      );
    } else if (text === '🎬 Add Movie') {
      userStates.set(chatId, 'adding_movie_name');
      tempData.set(chatId, { type: 'movie' });
      await bot.sendMessage(chatId, '🎬 Enter the movie name:', { reply_markup: { remove_keyboard: true } });
    } else if (text === '📺 Add Series') {
      userStates.set(chatId, 'adding_series_name');
      tempData.set(chatId, { type: 'series' });
      await bot.sendMessage(chatId, '📺 Enter the series name:', { reply_markup: { remove_keyboard: true } });
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
      const frontendUrl = 'https://seeubot.github.io/NS';
      await bot.sendMessage(chatId,
        `🌐 *Web Frontend:*\n${frontendUrl}\n\n` +
        `📱 *API Server:* ${KOYEB_URL}/api\n\n` +
        '🎬 Open the frontend URL to watch your movies and series!\n\n' +
        '✨ Your media library awaits!',
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
      );
    } else if (text === '📊 Library Stats') {
      const movieCount = await Movie.countDocuments();
      const seriesCount = await Series.countDocuments();
      const episodeCount = await Episode.countDocuments();

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
  const userId = callbackQuery.from.id;

  console.log(`🔘 Callback query: ${data}`);

  try {
    if (data.startsWith('add_new_season_to_series_')) {
      const seriesId = extractId(data, 'add_new_season_to_series_');
      tempData.set(chatId, { type: 'series', seriesId });
      userStates.set(chatId, 'adding_season_number');
      await bot.sendMessage(chatId, '🔢 Enter the new season number:', { reply_markup: { remove_keyboard: true } });
    } else if (data.startsWith('edit_series_episodes_')) {
      const seriesId = extractId(data, 'edit_series_episodes_');
      const series = await Series.findById(seriesId);
      if (!series) {
        await bot.sendMessage(chatId, '❌ Series not found. Please try again.', getMainMenuKeyboard());
        return;
      }
      tempData.set(chatId, { type: 'series', seriesId: seriesId });
      const seasons = await Episode.find({ seriesId }).distinct('seasonNumber').sort((a, b) => a - b);
      let keyboard = seasons.map(s => [{ text: `Season ${s}`, callback_data: `select_season_${seriesId}_${s}` }]);
      keyboard.push([{ text: '➕ Add New Season', callback_data: `add_new_season_to_series_${seriesId}` }]);

      await bot.sendMessage(chatId, '📺 *Select a season to manage episodes, or add a new season:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
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
        await Episode.deleteMany({ seriesId });
        await bot.sendMessage(chatId, `✅ Series "${deletedSeries.name}" and all its episodes deleted successfully!`, getMainMenuKeyboard());
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
      userStates.set(chatId, `editing_movie_${fieldToEdit}`);
      await bot.sendMessage(chatId, `✍️ Enter the new movie ${fieldToEdit.replace(/_/g, ' ')}:`);
    } else if (data.startsWith('edit_field_series_')) {
      const userData = tempData.get(chatId);
      if (!userData || userData.type !== 'series' || !userData.seriesId) {
        await bot.sendMessage(chatId, '❌ No series selected for editing. Please try again.', getMainMenuKeyboard());
        return;
      }
      const fieldToEdit = extractId(data, 'edit_field_series_');
      userStates.set(chatId, `editing_series_${fieldToEdit}`);
      await bot.sendMessage(chatId, `✍️ Enter the new series ${fieldToEdit.replace(/_/g, ' ')}:`);
    } else if (data.startsWith('select_season_')) {
      const parts = data.split('_');
      const seriesId = parts[2];
      const seasonNumber = parseInt(parts[3]);

      const series = await Series.findById(seriesId);
      if (!series) {
        await bot.sendMessage(chatId, '❌ Series not found.', getMainMenuKeyboard());
        return;
      }
      tempData.set(chatId, {
        type: 'series',
        seriesId: seriesId,
        seriesName: series.name,
        seasonNumber: seasonNumber
      });

      const episodeCount = await Episode.countDocuments({ seriesId, seasonNumber });
      let keyboard = [[{ text: '➕ Add New Episode', callback_data: `start_add_episode` }]];
      if (episodeCount > 0) {
        keyboard.push([{ text: `✍️ Edit/Delete Episodes (${episodeCount})`, callback_data: `start_edit_episodes` }]);
      }

      await bot.sendMessage(chatId, `📺 *Season ${seasonNumber} - ${series.name}*\n\nWhat would you like to do?`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else if (data === 'start_add_episode') {
      const userData = tempData.get(chatId);
      if (!userData || !userData.seriesId || !userData.seasonNumber) {
        await bot.sendMessage(chatId, '❌ No series or season in progress. Please start over.', getMainMenuKeyboard());
        userStates.delete(chatId);
        tempData.delete(chatId);
        return;
      }
      userStates.set(chatId, 'adding_episode_number');
      await bot.sendMessage(chatId, `📺 Season ${userData.seasonNumber} - Enter episode number:`);
    } else if (data.startsWith('start_edit_episodes')) {
      const userData = tempData.get(chatId);
      const seriesId = userData.seriesId;
      const seasonNumber = userData.seasonNumber;

      const episodes = await Episode.find({ seriesId, seasonNumber }).sort({ episodeNumber: 1 });
      if (episodes.length === 0) {
        await bot.sendMessage(chatId, '❌ No episodes to edit in this season.', getMainMenuKeyboard());
        return;
      }

      const episodeKeyboard = episodes.map(ep => [{
        text: `E${ep.episodeNumber}: ${ep.title}`,
        callback_data: `edit_episode_field_${ep._id}`
      }]);

      await bot.sendMessage(chatId, `✍️ *Select an episode to edit in Season ${seasonNumber}:*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: episodeKeyboard }
      });
    } else if (data.startsWith('edit_episode_field_')) {
      const episodeId = extractId(data, 'edit_episode_field_');
      const episode = await Episode.findById(episodeId);
      if (!episode) {
        await bot.sendMessage(chatId, '❌ Episode not found.', getMainMenuKeyboard());
        return;
      }

      tempData.set(chatId, {
        type: 'episode_edit',
        episodeId,
        seriesId: episode.seriesId,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        streamingUrl: episode.streamingUrl,
      });

      await bot.sendMessage(chatId,
        `✍️ *Editing Episode S${episode.seasonNumber}E${episode.episodeNumber}: ${episode.title}*\n\n` +
        `What would you like to edit?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✍️ Edit Title', callback_data: 'edit_field_episode_title' }],
              [{ text: '🔗 Edit Streaming URL', callback_data: 'edit_field_episode_streaming_url' }],
              [{ text: '❌ Cancel', callback_data: 'cancel' }]
            ]
          }
        }
      );
    } else if (data.startsWith('edit_field_episode_')) {
      const fieldToEdit = extractId(data, 'edit_field_episode_');
      userStates.set(chatId, `editing_episode_${fieldToEdit}`);
      await bot.sendMessage(chatId, `✍️ Enter the new episode ${fieldToEdit.replace(/_/g, ' ')}:`);
    } else if (data === 'add_another_episode') {
      const userData = tempData.get(chatId);
      if (userData && userData.seriesId && userData.seasonNumber) {
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Season ${userData.seasonNumber} - Enter next episode number:`);
      } else {
        await bot.sendMessage(chatId, '❌ No series or season in progress. Please start over.', getMainMenuKeyboard());
        userStates.delete(chatId);
        tempData.delete(chatId);
      }
    } else if (data === 'finish_series_flow') {
      await bot.sendMessage(chatId, `✅ Series management complete!`, getMainMenuKeyboard());
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
        try {
          const newSeries = new Series({ ...data, addedBy: userId });
          const series = await newSeries.save();
          tempData.set(chatId, { type: 'series', seriesId: series._id, seriesName: series.name });
          userStates.set(chatId, 'adding_season_number');
          await bot.sendMessage(chatId, `✅ Series "${data.name}" created! Now, 🔢 Enter season number:`);
        } catch (error) {
          console.error('Error saving series:', error);
          await bot.sendMessage(chatId, '❌ Error adding series. Please try again.', getMainMenuKeyboard());
        }
        break;
      case 'adding_season_number':
        const seasonNumber = parseInt(text.trim());
        if (isNaN(seasonNumber) || seasonNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid season number!');
          return;
        }
        const existingSeason = await Episode.findOne({ seriesId: data.seriesId, seasonNumber });
        if (existingSeason) {
          await bot.sendMessage(chatId, '⚠️ This season already exists. Please enter a different season number.');
          return;
        }
        data.seasonNumber = seasonNumber;
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Adding to Series "${data.seriesName}", Season ${seasonNumber}.\n\n🔢 Enter episode number:`);
        break;
      case 'adding_episode_number':
        const episodeNumber = parseInt(text.trim());
        if (isNaN(episodeNumber) || episodeNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid episode number!');
          return;
        }
        const existingEpisode = await Episode.findOne({ seriesId: data.seriesId, seasonNumber: data.seasonNumber, episodeNumber });
        if (existingEpisode) {
          await bot.sendMessage(chatId, `⚠️ Episode ${episodeNumber} already exists in Season ${data.seasonNumber}. Choose a different number.`);
          return;
        }
        data.episodeNumber = episodeNumber;
        userStates.set(chatId, `adding_episode_title`);
        await bot.sendMessage(chatId, `📺 S${data.seasonNumber}E${episodeNumber} - Enter episode title:`);
        break;
      case 'adding_episode_title':
        data.title = text.trim();
        userStates.set(chatId, `adding_episode_url`);
        await bot.sendMessage(chatId, '🔗 Enter episode streaming URL:');
        break;
      case 'adding_episode_url':
        data.streamingUrl = text.trim();
        try {
          const newEpisode = new Episode({
            seriesId: data.seriesId,
            seasonNumber: data.seasonNumber,
            episodeNumber: data.episodeNumber,
            title: data.title,
            streamingUrl: data.streamingUrl,
            addedBy: userId
          });
          await newEpisode.save();
          const episodeCount = await Episode.countDocuments({ seriesId: data.seriesId, seasonNumber: data.seasonNumber });
          await bot.sendMessage(chatId,
            `✅ Episode added! S${data.seasonNumber}E${data.episodeNumber}: ${data.title}\n\n` +
            `📊 Season ${data.seasonNumber} now has ${episodeCount} episode${episodeCount !== 1 ? 's' : ''}\n\n` +
            `What would you like to do next?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '➕ Add Another Episode', callback_data: 'add_another_episode' }],
                  [{ text: '🔢 Add New Season', callback_data: `add_new_season_to_series_${data.seriesId}` }],
                  [{ text: '✅ Finish', callback_data: 'finish_series_flow' }]
                ]
              }
            }
          );
        } catch (error) {
          console.error('Error saving episode:', error);
          await bot.sendMessage(chatId, '❌ Error saving episode. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
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
      case 'editing_episode_title':
        try {
          await Episode.findByIdAndUpdate(data.episodeId, { title: text.trim() });
          await bot.sendMessage(chatId, `✅ Episode title updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating episode title:', error);
          await bot.sendMessage(chatId, '❌ Error updating episode title. Please try again.', getMainMenuKeyboard());
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
      case 'editing_episode_streaming_url':
        try {
          await Episode.findByIdAndUpdate(data.episodeId, { streamingUrl: text.trim() });
          await bot.sendMessage(chatId, `✅ Episode streaming URL updated successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error updating episode streaming URL:', error);
          await bot.sendMessage(chatId, '❌ Error updating episode streaming URL. Please try again.', getMainMenuKeyboard());
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

// ✨ UPDATED: Unified API endpoint for movies and series
app.get('/api/media', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let results = [];

    // Base query for both models
    let movieQuery = search ? { name: { $regex: search, $options: 'i' } } : {};
    let seriesQuery = search ? { name: { $regex: search, $options: 'i' } } : {};

    if (!type || type === 'movie') {
      const movies = await Movie.find(movieQuery).sort({ addedAt: -1 }).limit(parseInt(limit)).skip(offset);
      results = results.concat(movies);
    }

    if (!type || type === 'series') {
      const series = await Series.find(seriesQuery).sort({ addedAt: -1 }).limit(parseInt(limit)).skip(offset);
      results = results.concat(series);
    }

    // Sort combined results by most recent first
    results.sort((a, b) => b.addedAt - a.addedAt);

    res.json(results);
  } catch (error) {
    console.error('❌ Error fetching media:', error);
    res.status(500).json({ error: 'Failed to fetch media', details: error.message });
  }
});

// ✨ UPDATED: Endpoint for fetching a single series with its episodes
app.get('/api/series/:id', async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    const episodes = await Episode.find({ seriesId: series._id }).sort({ seasonNumber: 1, episodeNumber: 1 });
    res.json({ ...series._doc, episodes });
  } catch (error) {
    console.error('❌ Error fetching series details:', error);
    res.status(500).json({ error: 'Failed to fetch series details', details: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const movieCount = await Movie.countDocuments();
    const seriesCount = await Series.countDocuments();
    const episodeCount = await Episode.countDocuments();
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
      seriesById: '/api/series/:id',
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
  console.log('   • GET  /api/media      - Get all media (movies & series)');
  console.log('   • GET  /api/series/:id - Get series details with episodes');
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
