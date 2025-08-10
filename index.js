require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');

// ================================================================
// CONFIGURATION
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN || '7545348868:AAGjvrcDALv0O8fH5NmDzBkXFWrgIRdKYek';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/?retryWrites=true&w=majority&appName=movie';
const PORT = process.env.PORT || 8000;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';

// Initialize bot with polling by default (more reliable than webhooks)
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: !USE_WEBHOOK,
  request: {
    agentOptions: {
      keepAlive: true,
      family: 4
    }
  }
});

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

// Serve the frontend HTML directly
app.use(express.static('public'));

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

// Global handler for bot messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  console.log(`📱 Message from ${userId}: ${text}`);

  try {
    if (text === '/start') {
      const keyboard = {
        reply_markup: {
          keyboard: [
            ['🎬 Add Movie', '📺 Add Series'],
            ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
            ['🌐 Open Frontend', '📊 Stats']
          ],
          resize_keyboard: true
        }
      };
      await bot.sendMessage(chatId, '🎭 Welcome to Movie & Series Manager Bot!\n\nChoose an option below:', keyboard);
    } else if (text === '🎬 Add Movie') {
      userStates.set(chatId, 'adding_movie_name');
      tempData.set(chatId, { type: 'movie' });
      await bot.sendMessage(chatId, '🎬 Enter the movie name:', { reply_markup: { remove_keyboard: true } });
    } else if (text === '📺 Add Series') {
      const seriesList = await Series.find({}, 'name');
      if (seriesList.length > 0) {
        const seriesKeyboard = seriesList.map(s => [{ text: s.name, callback_data: `add_to_series_${s._id}` }]);
        seriesKeyboard.push([{ text: '➕ Create New Series', callback_data: 'create_new_series' }]);
        await bot.sendMessage(chatId, '📺 Choose a series to add to, or create a new one:', {
          reply_markup: { inline_keyboard: seriesKeyboard }
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
        await bot.sendMessage(chatId, '📽️ No movies found! Add some first.');
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
      const seriesList = await Series.find().limit(10);
      if (seriesList.length === 0) {
        await bot.sendMessage(chatId, '📺 No series found! Add some first.');
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
    } else if (text === '🌐 Open Frontend') {
      const frontendUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
      await bot.sendMessage(chatId, `🌐 *Frontend URL:*\n${frontendUrl}\n\n🎬 Open this link to watch your movies and series!`, {
        parse_mode: 'Markdown'
      });
    } else if (text === '📊 Stats') {
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
        `📹 Total Episodes: ${episodeCount}\n\n` +
        `🎭 Total Content: ${movieCount + seriesCount} items`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await handleConversationFlow(chatId, text, userId);
    }
  } catch (error) {
    console.error('❌ Error handling message:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again or use /start to restart.');
  }
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;

  console.log(`🔘 Callback query: ${data}`);

  try {
    if (data.startsWith('add_to_series_')) {
      const seriesId = data.replace('add_to_series_', '');
      const series = await Series.findById(seriesId);
      if (series) {
        tempData.set(chatId, { type: 'series', seriesId: seriesId, name: series.name, thumbnail: series.thumbnail, seasons: [...series.seasons] });
        userStates.set(chatId, 'adding_season_number_existing');
        await bot.sendMessage(chatId, `📺 Adding to "${series.name}"\n\n🔢 Enter the season number (or "done" to finish):`, { reply_markup: { remove_keyboard: true } });
      }
    } else if (data === 'create_new_series') {
      userStates.set(chatId, 'adding_series_name');
      tempData.set(chatId, { type: 'series' });
      await bot.sendMessage(chatId, '📺 Enter the new series name:', { reply_markup: { remove_keyboard: true } });
    } else if (data.startsWith('delete_movie_')) {
      const movieId = data.replace('delete_movie_', '');
      try {
        const deletedMovie = await Movie.findByIdAndDelete(movieId);
        if (deletedMovie) {
          await bot.sendMessage(chatId, `✅ Movie "${deletedMovie.name}" deleted successfully!`);
        } else {
          await bot.sendMessage(chatId, '❌ Movie not found.');
        }
      } catch (error) {
        await bot.sendMessage(chatId, '❌ Error deleting movie.');
      }
    } else if (data.startsWith('delete_series_')) {
      const seriesId = data.replace('delete_series_', '');
      try {
        const deletedSeries = await Series.findByIdAndDelete(seriesId);
        if (deletedSeries) {
          await bot.sendMessage(chatId, `✅ Series "${deletedSeries.name}" deleted successfully!`);
        } else {
          await bot.sendMessage(chatId, '❌ Series not found.');
        }
      } catch (error) {
        await bot.sendMessage(chatId, '❌ Error deleting series.');
      }
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('❌ Error handling callback query:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred' });
  }
});

async function handleConversationFlow(chatId, text, userId) {
  const state = userStates.get(chatId);
  const data = tempData.get(chatId) || {};

  try {
    switch (state) {
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
              keyboard: [
                ['🎬 Add Movie', '📺 Add Series'],
                ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
                ['🌐 Open Frontend', '📊 Stats']
              ],
              resize_keyboard: true
            }
          });
        } catch (error) {
          await bot.sendMessage(chatId, '❌ Error adding movie. Please try again.');
        }
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;

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
      
      case 'adding_season_number_existing':
      case 'adding_season_number':
        if (text.toLowerCase() === 'done') {
          if (data.seasons.length === 0) {
            await bot.sendMessage(chatId, '⚠️ Please add at least one season with episodes!');
            return;
          }
          try {
            if (data.seriesId) {
              // Update existing series
              await Series.findByIdAndUpdate(data.seriesId, { seasons: data.seasons });
              await bot.sendMessage(chatId, `✅ Episodes added to "${data.name}" successfully!`, {
                reply_markup: {
                  keyboard: [
                    ['🎬 Add Movie', '📺 Add Series'],
                    ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
                    ['🌐 Open Frontend', '📊 Stats']
                  ],
                  resize_keyboard: true
                }
              });
            } else {
              // Create new series
              const series = new Series({ ...data, addedBy: userId });
              await series.save();
              await bot.sendMessage(chatId, `✅ Series "${data.name}" created successfully!`, {
                reply_markup: {
                  keyboard: [
                    ['🎬 Add Movie', '📺 Add Series'],
                    ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
                    ['🌐 Open Frontend', '📊 Stats']
                  ],
                  resize_keyboard: true
                }
              });
            }
          } catch (error) {
            await bot.sendMessage(chatId, '❌ Error saving series. Please try again.');
          }
          userStates.delete(chatId);
          tempData.delete(chatId);
          return;
        }
        const seasonNumber = parseInt(text);
        if (isNaN(seasonNumber) || seasonNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid season number!');
          return;
        }
        
        // Check if season already exists
        const existingSeason = data.seasons.find(s => s.seasonNumber === seasonNumber);
        if (existingSeason) {
          data.currentSeason = existingSeason;
        } else {
          data.currentSeason = { seasonNumber, episodes: [] };
        }
        
        userStates.set(chatId, 'adding_episode_number');
        await bot.sendMessage(chatId, `📺 Season ${seasonNumber} - Enter episode number (or "next" for new season, "done" to finish):`);
        break;
      
      case 'adding_episode_number':
        if (text.toLowerCase() === 'next') {
          if (data.currentSeason.episodes.length === 0) {
            await bot.sendMessage(chatId, '⚠️ Please add at least one episode to this season!');
            return;
          }
          // Update or add the current season
          const seasonIndex = data.seasons.findIndex(s => s.seasonNumber === data.currentSeason.seasonNumber);
          if (seasonIndex >= 0) {
            data.seasons[seasonIndex] = data.currentSeason;
          } else {
            data.seasons.push(data.currentSeason);
          }
          userStates.set(chatId, 'adding_season_number');
          await bot.sendMessage(chatId, '🔢 Enter next season number (or "done" to finish):');
          return;
        }
        if (text.toLowerCase() === 'done') {
          if (data.currentSeason && data.currentSeason.episodes.length > 0) {
            const seasonIndex = data.seasons.findIndex(s => s.seasonNumber === data.currentSeason.seasonNumber);
            if (seasonIndex >= 0) {
              data.seasons[seasonIndex] = data.currentSeason;
            } else {
              data.seasons.push(data.currentSeason);
            }
          }
          if (data.seasons.length === 0) {
            await bot.sendMessage(chatId, '⚠️ Please add at least one season with episodes!');
            return;
          }
          try {
            if (data.seriesId) {
              await Series.findByIdAndUpdate(data.seriesId, { seasons: data.seasons });
              await bot.sendMessage(chatId, `✅ Episodes added to "${data.name}" successfully!`, {
                reply_markup: {
                  keyboard: [
                    ['🎬 Add Movie', '📺 Add Series'],
                    ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
                    ['🌐 Open Frontend', '📊 Stats']
                  ],
                  resize_keyboard: true
                }
              });
            } else {
              const series = new Series({ ...data, addedBy: userId });
              await series.save();
              await bot.sendMessage(chatId, `✅ Series "${data.name}" created with ${data.seasons.length} season(s)!`, {
                reply_markup: {
                  keyboard: [
                    ['🎬 Add Movie', '📺 Add Series'],
                    ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
                    ['🌐 Open Frontend', '📊 Stats']
                  ],
                  resize_keyboard: true
                }
              });
            }
            userStates.delete(chatId);
            tempData.delete(chatId);
          } catch (error) {
            await bot.sendMessage(chatId, '❌ Error saving series. Please try again.');
          }
          return;
        }
        const episodeNumber = parseInt(text);
        if (isNaN(episodeNumber) || episodeNumber <= 0) {
          await bot.sendMessage(chatId, '⚠️ Please enter a valid episode number!');
          return;
        }
        
        // Check if episode already exists
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
        data.currentEpisode.title = text;
        userStates.set(chatId, 'adding_episode_url');
        await bot.sendMessage(chatId, '🔗 Enter episode streaming URL:');
        break;

      case 'adding_episode_url':
        data.currentEpisode.streamingUrl = text;
        data.currentSeason.episodes.push(data.currentEpisode);
        
        const totalEpisodes = data.currentSeason.episodes.length;
        await bot.sendMessage(chatId, 
          `✅ Episode added! S${data.currentSeason.seasonNumber}E${data.currentEpisode.episodeNumber}: ${data.currentEpisode.title}\n\n` +
          `📊 Season ${data.currentSeason.seasonNumber} now has ${totalEpisodes} episode${totalEpisodes !== 1 ? 's' : ''}\n\n` +
          `📺 Enter next episode number (or "next" for new season, "done" to finish):`
        );
        userStates.set(chatId, 'adding_episode_number');
        break;

      default:
        // Handle unknown states or provide help
        const keyboard = {
          reply_markup: {
            keyboard: [
              ['🎬 Add Movie', '📺 Add Series'],
              ['✍️ Edit/Delete Movies', '🗑️ Edit/Delete Series'],
              ['🌐 Open Frontend', '📊 Stats']
            ],
            resize_keyboard: true
          }
        };
        await bot.sendMessage(chatId, '❓ I didn\'t understand that. Please use the menu buttons or type /start to restart.', keyboard);
        userStates.delete(chatId);
        tempData.delete(chatId);
        break;
    }
    tempData.set(chatId, data);
  } catch (error) {
    console.error('❌ Error in conversation flow:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again or use /start to restart.');
    userStates.delete(chatId);
    tempData.delete(chatId);
  }
}

// ================================================================
// API ENDPOINTS
// ================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    bot: USE_WEBHOOK ? 'webhook' : 'polling',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Get all movies
app.get('/api/movies', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const query = search ? { name: { $regex: search, $options: 'i' } } : {};
    
    const movies = await Movie.find(query)
      .sort({ addedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Movie.countDocuments(query);
    
    res.json({
      movies,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error('❌ Error fetching movies:', error);
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

// Get all series
app.get('/api/series', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const query = search ? { name: { $regex: search, $options: 'i' } } : {};
    
    const series = await Series.find(query)
      .sort({ addedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Series.countDocuments(query);
    
    res.json({
      series,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error('❌ Error fetching series:', error);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// Get single series by ID
app.get('/api/series/:id', async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    res.json(series);
  } catch (error) {
    console.error('❌ Error fetching series details:', error);
    res.status(500).json({ error: 'Failed to fetch series details' });
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

// ================================================================
// WEBHOOK SETUP (OPTIONAL)
// ================================================================

if (USE_WEBHOOK) {
  const crypto = require('crypto');
  const webhookPath = `/webhook-${crypto.randomBytes(16).toString('hex')}`;
  
  app.post(webhookPath, (req, res) => {
    console.log('📨 Received webhook update');
    try {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (error) {
      console.error('❌ Error processing webhook update:', error);
      res.sendStatus(500);
    }
  });
}

// Serve frontend
app.get('/', (req, res) => {
  const frontendHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Movie & TV Series Manager</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #fff;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            padding: 30px;
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            background: linear-gradient(45deg, #fff, #f0f0f0);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .tabs {
            display: flex;
            justify-content: center;
            margin-bottom: 30px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            padding: 5px;
            backdrop-filter: blur(10px);
        }

        .tab {
            flex: 1;
            text-align: center;
            padding: 15px 20px;
            background: transparent;
            border: none;
            color: #fff;
            font-size: 1.1em;
            cursor: pointer;
            border-radius: 10px;
            transition: all 0.3s ease;
        }

        .tab.active {
            background: rgba(255, 255, 255, 0.2);
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 25px;
        }

        .card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.2);
            transition: all 0.3s ease;
            cursor: pointer;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }

        .card-image {
            width: 100%;
            height: 200px;
            object-fit: cover;
        }

        .card-content {
            padding: 20px;
        }

        .loading {
            text-align: center;
            padding: 50px;
            font-size: 1.2em;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎬 Movie & TV Series Manager</h1>
            <p>Your personal streaming library</p>
        </div>

        <div class="tabs">
            <button class="tab active" onclick="showTab('movies')">🎬 Movies</button>
            <button class="tab" onclick="showTab('series')">📺 TV Series</button>
        </div>

        <div id="movies" class="content">
            <div class="loading">Loading movies...</div>
            <div id="movies-grid" class="grid"></div>
        </div>

        <div id="series" class="content" style="display: none;">
            <div class="loading">Loading TV series...</div>
            <div id="series-grid" class="grid"></div>
        </div>
    </div>

    <script>
        function showTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.content').forEach(c => c.style.display = 'none');
            
            document.querySelector(\`[onclick="showTab('\${tab}')"]\`).classList.add('active');
            document.getElementById(tab).style.display = 'block';
        }

        async function loadMovies() {
            try {
                const response = await fetch('/api/movies');
                const data = await response.json();
                const grid = document.getElementById('movies-grid');
                
                if (data.movies && data.movies.length > 0) {
                    grid.innerHTML = data.movies.map(movie => \`
                        <div class="card">
                            <img src="\${movie.thumbnail}" alt="\${movie.name}" class="card-image">
                            <div class="card-content">
                                <h3>\${movie.name}</h3>
                                <p>Added \${new Date(movie.addedAt).toLocaleDateString()}</p>
                            </div>
                        </div>
                    \`).join('');
                } else {
                    grid.innerHTML = '<div class="loading">No movies found. Add some using the Telegram bot!</div>';
                }
            } catch (error) {
                console.error('Error loading movies:', error);
                document.getElementById('movies-grid').innerHTML = '<div class="loading">Error loading movies</div>';
            }
        }

        async function loadSeries() {
            try {
                const response = await fetch('/api/series');
                const data = await response.json();
                const grid = document.getElementById('series-grid');
                
                if (data.series && data.series.length > 0) {
                    grid.innerHTML = data.series.map(series => \`
                        <div class="card">
                            <img src="\${series.thumbnail}" alt="\${series.name}" class="card-image">
                            <div class="card-content">
                                <h3>\${series.name}</h3>
                                <p>\${series.seasons.length} Season\${series.seasons.length !== 1 ? 's' : ''}</p>
                            </div>
                        </div>
                    \`).join('');
                } else {
                    grid.innerHTML = '<div class="loading">No series found. Add some using the Telegram bot!</div>';
                }
            } catch (error) {
                console.error('Error loading series:', error);
                document.getElementById('series-grid').innerHTML = '<div class="loading">Error loading series</div>';
            }
        }

        // Load data when page loads
        document.addEventListener('DOMContentLoaded', function() {
            loadMovies();
            loadSeries();
        });
    </script>
</body>
</html>`;
  
  res.send(frontendHTML);
});

// ================================================================
// SERVER START
// ================================================================

app.listen(PORT, '0.0.0.0', async () => {
  console.log(\`🚀 Server running on port \${PORT}\`);
  console.log(\`🌐 Frontend available at: http://localhost:\${PORT}\`);
  console.log(\`🤖 Bot mode: \${USE_WEBHOOK ? 'Webhook' : 'Polling'}\`);
  
  if (USE_WEBHOOK) {
    // Webhook setup code here if needed
    console.log('📡 Webhook mode enabled - configure WEBHOOK_URL environment variable');
  } else {
    console.log('🔄 Polling mode active - bot is ready to receive messages');
  }
  
  console.log('✅ Application started successfully!');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  try {
    if (!USE_WEBHOOK) {
      bot.stopPolling();
    }
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  try {
    if (!USE_WEBHOOK) {
      bot.stopPolling();
    }
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  process.exit(0);
});
