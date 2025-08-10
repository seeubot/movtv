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

// Use your actual BOT_TOKEN from the environment variables
const BOT_TOKEN = process.env.BOT_TOKEN; 
// Use your actual MONGODB_URI from the environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 1024;
// Use a different port for local polling to avoid conflicts, if you choose that method
const POLLING_PORT = process.env.POLLING_PORT || 8001; 
// Set USE_WEBHOOK to 'true' in your Koyeb environment variables for production
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
// The public URL for your deployed application
const KOYEB_URL = process.env.FRONTEND_URL;
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

// Initialize bot. The webhook mode is configured to work with the Express app.
let bot;
if (USE_WEBHOOK) {
  // Pass the bot token but don't start its internal server.
  bot = new TelegramBot(BOT_TOKEN, { onlyFirstMatch: true });
  console.log('🤖 Bot initialized for Webhook mode. Waiting for Express to start...');
} else {
  // Use polling for local development, which starts its own server on a different port.
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log('🤖 Bot started in Polling mode.');
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

// Add text indexes for search functionality.
movieSchema.index({ name: 'text' });
seriesSchema.index({ name: 'text' });

const Movie = mongoose.model('Movie', movieSchema);
const Series = mongoose.model('Series', seriesSchema);

// ================================================================
// EXPRESS APP & MIDDLEWARE
// ================================================================

const app = express();

app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:8080', 'http://127.0.0.1:8080', '*'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// The bot's webhook endpoint, handled by the Express server.
if (USE_WEBHOOK) {
  app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// Serve static files from public directory (including your frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// BOT STATE MANAGEMENT & CONVERSATION FLOWS
// ================================================================

const userStates = new Map();
const tempData = new Map();

// Bot error handling
bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.code, error.message);
  if (error.code === 'EFATAL') {
    console.log('🔄 Restarting bot polling...');
    setTimeout(() => {
      bot.startPolling({ restart: true });
    }, 5000);
  }
});

bot.on('webhook_error', (error) => {
  console.error('Telegram webhook error:', error);
});

// Main menu keyboard
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

// Bot message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  console.log(`📱 Message from ${userId}: ${text}`);

  try {
    if (text === '/start') {
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
      const seriesList = await Series.find({}, 'name').limit(20);
      if (seriesList.length > 0) {
        const seriesKeyboard = seriesList.map(s => [{ text: s.name, callback_data: `add_to_series_${s._id}` }]);
        seriesKeyboard.push([{ text: '➕ Create New Series', callback_data: 'create_new_series' }]);
        await bot.sendMessage(chatId, '📺 Choose a series to add episodes to, or create a new one:', {
          reply_markup: { inline_keyboard: seriesKeyboard }
        });
      } else {
        userStates.set(chatId, 'adding_series_name');
        tempData.set(chatId, { type: 'series' });
        await bot.sendMessage(chatId, '📺 Enter the series name:', { reply_markup: { remove_keyboard: true } });
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
  }
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;

  console.log(`🔘 Callback query: ${data}`);

  try {
    if (data.startsWith('add_to_series_')) {
      const seriesId = data.replace('add_to_series_', '');
      const series = await Series.findById(seriesId);
      if (series) {
        tempData.set(chatId, { 
          type: 'series', 
          seriesId: seriesId, 
          name: series.name, 
          thumbnail: series.thumbnail, 
          seasons: [...series.seasons] 
        });
        userStates.set(chatId, 'adding_season_number_existing');
        await bot.sendMessage(chatId, `📺 Adding to "${series.name}"\n\n🔢 Enter the season number:`, { reply_markup: { remove_keyboard: true } });
      }
    } else if (data === 'create_new_series') {
      userStates.set(chatId, 'adding_series_name');
      tempData.set(chatId, { type: 'series' });
      await bot.sendMessage(chatId, '📺 Enter the new series name:', { reply_markup: { remove_keyboard: true } });
    } else if (data.startsWith('delete_movie_')) {
      const movieId = data.replace('delete_movie_', '');
      const deletedMovie = await Movie.findByIdAndDelete(movieId);
      if (deletedMovie) {
        await bot.sendMessage(chatId, `✅ Movie "${deletedMovie.name}" deleted successfully!`, getMainMenuKeyboard());
      } else {
        await bot.sendMessage(chatId, '❌ Movie not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('delete_series_')) {
      const seriesId = data.replace('delete_series_', '');
      const deletedSeries = await Series.findByIdAndDelete(seriesId);
      if (deletedSeries) {
        await bot.sendMessage(chatId, `✅ Series "${deletedSeries.name}" deleted successfully!`, getMainMenuKeyboard());
      } else {
        await bot.sendMessage(chatId, '❌ Series not found.', getMainMenuKeyboard());
      }
    } else if (data.startsWith('edit_movie_')) {
      const movieId = data.replace('edit_movie_', '');
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
      const seriesId = data.replace('edit_series_', '');
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
                [{ text: '➕ Add/Edit Episodes', callback_data: `edit_series_episodes` }],
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

        const fieldToEdit = data.replace('edit_field_movie_', '');

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
        
        const fieldToEdit = data.replace('edit_field_series_', '');

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
    } else if (data === 'edit_series_episodes') {
      const userData = tempData.get(chatId);
      if (!userData || userData.type !== 'series' || !userData.seriesId) {
          await bot.sendMessage(chatId, '❌ No series selected for editing. Please try again.', getMainMenuKeyboard());
          return;
      }
      
      const series = await Series.findById(userData.seriesId);
      if (!series || series.seasons.length === 0) {
        await bot.sendMessage(chatId, '❌ No seasons found. Add a season first.', getMainMenuKeyboard());
        return;
      }
      const seasonKeyboard = series.seasons.map(s => [
        { text: `Season ${s.seasonNumber}`, callback_data: `add_to_series_${series._id}` }
      ]);
      await bot.sendMessage(chatId, '📺 Select a season to manage episodes:', {
        reply_markup: { inline_keyboard: seasonKeyboard }
      });
    } else if (data === 'add_another_episode') {
      const userData = tempData.get(chatId);
      if (userData && userData.currentSeason) {
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Season ${userData.currentSeason.seasonNumber} - Enter next episode number:`);
      }
    } else if (data === 'add_new_season') {
      userStates.set(chatId, 'adding_season_number');
      await bot.sendMessage(chatId, '🔢 Enter new season number:');
    } else if (data === 'finish_series') {
      const userData = tempData.get(chatId);
      if (userData && userData.seriesId) {
        try {
          await Series.findByIdAndUpdate(userData.seriesId, { seasons: userData.seasons });
          await bot.sendMessage(chatId, `✅ Episodes added to "${userData.name}" successfully!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error saving series:', error);
          await bot.sendMessage(chatId, '❌ Error saving series. Please try again.', getMainMenuKeyboard());
        }
      } else if (userData) {
        try {
          const series = new Series({ 
            name: userData.name,
            thumbnail: userData.thumbnail,
            seasons: userData.seasons,
            addedBy: callbackQuery.from.id
          });
          await series.save();
          await bot.sendMessage(chatId, `✅ Series "${userData.name}" created with ${userData.seasons.length} season(s)!`, getMainMenuKeyboard());
        } catch (error) {
          console.error('Error saving series:', error);
          await bot.sendMessage(chatId, '❌ Error saving series. Please try again.', getMainMenuKeyboard());
        }
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
  }
});

// Conversation flow handler
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
      
      case 'adding_season_number_existing':
      case 'adding_season_number':
        const seasonNumber = parseInt(text.trim());
        if (isNaN(seasonNumber) || seasonNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid season number!');
          return;
        }
        
        const existingSeason = data.seasons.find(s => s.seasonNumber === seasonNumber);
        if (existingSeason) {
          data.currentSeason = existingSeason;
        } else {
          data.currentSeason = { seasonNumber, episodes: [] };
        }
        
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
        userStates.set(chatId, 'adding_episode_title');
        await bot.sendMessage(chatId, `📺 S${data.currentSeason.seasonNumber}E${episodeNumber} - Enter episode title:`);
        break;

      case 'adding_episode_title':
        data.currentEpisode.title = text.trim();
        userStates.set(chatId, 'adding_episode_url');
        await bot.sendMessage(chatId, '🔗 Enter episode streaming URL:');
        break;

      case 'adding_episode_url':
        data.currentEpisode.streamingUrl = text.trim();
        data.currentSeason.episodes.push(data.currentEpisode);
        
        // Update or add the current season to the series
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
                [{ text: '🔢 Add New Season', callback_data: 'add_new_season' }],
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

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    bot: USE_WEBHOOK ? 'webhook' : 'polling',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Get all movies (compatible with your frontend)
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

// Get all series (compatible with your frontend)
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

// Get single series by ID (for your frontend modal)
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

// Get statistics
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

// Serve your custom frontend at root with dynamic API URL injection
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

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Media Manager API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      movies: '/api/movies',
      series: '/api/series',
      seriesById: '/api/series/:id',
      stats: '/api/stats',
      health: '/health'
    },
    message: 'Frontend is available at the root URL /'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error', details: error.message });
});

// ================================================================
// SERVER START
// ================================================================

app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 Media Manager API Server running on port', PORT);
  console.log('🌐 API Base URL:', KOYEB_URL ? `${KOYEB_URL}/api` : `http://localhost:${PORT}/api`);
  console.log('🤖 Bot mode:', USE_WEBHOOK ? 'Webhook' : 'Polling');
  
  if (USE_WEBHOOK && KOYEB_URL) {
    const webhookUrl = `${KOYEB_URL}${WEBHOOK_PATH}`;
    console.log(`Setting Telegram webhook to: ${webhookUrl}`);
    try {
      // Use the express app's URL for the webhook
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook set successfully!');
    } catch (e) {
      console.error('❌ Failed to set webhook:', e.message);
    }
  }

  console.log('📋 Available endpoints:');
  console.log('   • GET  /api/movies     - Get all movies');
  console.log('   • GET  /api/series     - Get all series');
  console.log('   • GET  /api/series/:id - Get series details');
  console.log('   • GET  /api/stats      - Get library statistics');
  console.log('   • GET  /health         - Health check');
  console.log('✅ Server ready! Connect your frontend to this API.');
});

// Graceful shutdown
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

