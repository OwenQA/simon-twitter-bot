require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    twitterBearerToken: process.env.TWITTER_BEARER_TOKEN,
    twitterUsernames: (process.env.TWITTER_USERNAMES || process.env.TWITTER_USERNAME || 'Hytale').split(',').map(u => u.trim()),
    // Default to 60 min - Twitter free tier is very limited (1,500 tweets/month)
    checkIntervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 60
};

// File to store processed tweet IDs
const PROCESSED_TWEETS_FILE = path.join(__dirname, 'processed_tweets.json');

// Rate limiting state
let apiFailures = 0;
let lastApiFailure = 0;
const MAX_BACKOFF_MINUTES = 60;

// Load processed tweets
function loadProcessedTweets() {
    try {
        if (fs.existsSync(PROCESSED_TWEETS_FILE)) {
            const data = fs.readFileSync(PROCESSED_TWEETS_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (error) {
        console.error('Error loading processed tweets:', error.message);
    }
    return new Set();
}

// Save processed tweets
function saveProcessedTweets(tweets) {
    try {
        // Keep only last 1000 tweets to prevent file from growing too large
        const tweetsArray = Array.from(tweets).slice(-1000);
        fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify(tweetsArray, null, 2));
    } catch (error) {
        console.error('Error saving processed tweets:', error.message);
    }
}

let processedTweets = loadProcessedTweets();

// Reset processed tweets if requested (useful for forcing re-post of recent tweets)
if (process.env.RESET_PROCESSED === 'true') {
    console.log('🔄 RESET_PROCESSED=true, clearing processed tweets cache...');
    processedTweets = new Set();
    saveProcessedTweets(processedTweets);
}

// Cache for user profile data (keyed by username)
const cachedUserProfiles = {};

// Discord embed colors
const COLORS = {
    tweet: 0x1DA1F2,      // Twitter blue
    reply: 0x657786,      // Gray for replies
    retweet: 0x17BF63,    // Green for retweets
    quote: 0xFFAD1F       // Orange for quote tweets
};

// Calculate backoff time based on failures
function getBackoffMinutes() {
    if (apiFailures === 0) return 0;
    // Exponential backoff: 2, 4, 8, 16, 32, 60 (max)
    const backoff = Math.min(Math.pow(2, apiFailures), MAX_BACKOFF_MINUTES);
    return backoff;
}

// Check if we should skip API due to rate limiting
function shouldSkipApi() {
    if (apiFailures === 0) return false;
    const backoffMs = getBackoffMinutes() * 60 * 1000;
    const timeSinceFailure = Date.now() - lastApiFailure;
    if (timeSinceFailure < backoffMs) {
        console.log(`⏳ API backoff: waiting ${Math.ceil((backoffMs - timeSinceFailure) / 60000)} more minutes`);
        return true;
    }
    return false;
}

// Record API failure
function recordApiFailure() {
    apiFailures++;
    lastApiFailure = Date.now();
    console.log(`⚠️ API failure #${apiFailures}, backing off for ${getBackoffMinutes()} minutes`);
}

// Record API success
function recordApiSuccess() {
    if (apiFailures > 0) {
        console.log('✅ API recovered, resetting backoff');
    }
    apiFailures = 0;
}

// Fetch user profile (name and avatar)
async function fetchUserProfile(username) {
    if (cachedUserProfiles[username]) {
        return cachedUserProfiles[username];
    }

    if (!config.twitterBearerToken || shouldSkipApi()) {
        return {
            name: username,
            username: username,
            profileImageUrl: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
        };
    }

    try {
        const response = await axios.get(
            `https://api.twitter.com/2/users/by/username/${username}`,
            {
                headers: { 'Authorization': `Bearer ${config.twitterBearerToken}` },
                params: {
                    'user.fields': 'name,profile_image_url,description'
                },
                timeout: 10000
            }
        );

        const user = response.data.data;
        if (user) {
            // Get higher resolution profile image (replace _normal with _400x400)
            const profileImageUrl = user.profile_image_url?.replace('_normal', '_400x400') || 
                                   'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
            
            cachedUserProfiles[username] = {
                id: user.id,
                name: user.name,
                username: user.username,
                profileImageUrl: profileImageUrl,
                description: user.description
            };
            
            recordApiSuccess();
            console.log(`✅ Loaded profile for ${user.name} (@${user.username})`);
            return cachedUserProfiles[username];
        }
    } catch (error) {
        const status = error.response?.status;
        if (status === 429) {
            recordApiFailure();
            console.error(`❌ Rate limited fetching profile for @${username}`);
        } else {
            console.error(`❌ Error fetching profile for @${username}:`, error.response?.data || error.message);
        }
    }

    return {
        name: username,
        username: username,
        profileImageUrl: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
    };
}

// Send message to Discord webhook
async function sendToDiscord(embed, userProfile) {
    if (!config.discordWebhookUrl) {
        console.error('❌ Discord webhook URL not configured!');
        return false;
    }

    try {
        await axios.post(config.discordWebhookUrl, {
            username: userProfile?.name || 'Twitter',
            avatar_url: userProfile?.profileImageUrl || 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
            embeds: [embed]
        }, { timeout: 10000 });
        console.log('✅ Sent to Discord:', embed.title?.substring(0, 50) || 'Tweet');
        return true;
    } catch (error) {
        console.error('❌ Error sending to Discord:', error.response?.data || error.message);
        return false;
    }
}

// Create Discord embed from tweet data
function createTweetEmbed(tweet, userProfile) {
    const isReply = tweet.isReply || tweet.text?.startsWith('@');
    const isRetweet = tweet.isRetweet || tweet.text?.startsWith('RT @');
    const isQuote = tweet.isQuote;

    let color = COLORS.tweet;
    let title = '📢 New Tweet';
    
    if (isReply) {
        color = COLORS.reply;
        title = '💬 New Reply';
    } else if (isRetweet) {
        color = COLORS.retweet;
        title = '🔁 Retweet';
    } else if (isQuote) {
        color = COLORS.quote;
        title = '💭 Quote Tweet';
    }

    const displayName = userProfile?.name || tweet.username;
    const username = userProfile?.username || tweet.username;
    const avatarUrl = userProfile?.profileImageUrl || 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';

    const embed = {
        title: title,
        description: tweet.text?.substring(0, 4096) || 'No content',
        color: color,
        author: {
            name: `${displayName} (@${username})`,
            url: `https://twitter.com/${username}`,
            icon_url: avatarUrl
        },
        url: tweet.url,
        thumbnail: {
            url: avatarUrl
        },
        timestamp: tweet.createdAt ? new Date(tweet.createdAt).toISOString() : new Date().toISOString(),
        footer: {
            text: 'Twitter / X',
            icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
        }
    };

    // Add image if present
    if (tweet.image) {
        embed.image = { url: tweet.image };
    }

    // Add engagement stats if available
    if (tweet.likes !== undefined || tweet.retweets !== undefined) {
        embed.fields = [];
        if (tweet.likes !== undefined) {
            embed.fields.push({ name: '❤️ Likes', value: tweet.likes.toString(), inline: true });
        }
        if (tweet.retweets !== undefined) {
            embed.fields.push({ name: '🔁 Retweets', value: tweet.retweets.toString(), inline: true });
        }
    }

    return embed;
}

// Fetch tweets from Twitter API
async function fetchTweets(username) {
    if (!config.twitterBearerToken) {
        console.error('❌ TWITTER_BEARER_TOKEN is required!');
        return [];
    }

    if (shouldSkipApi()) {
        return [];
    }

    try {
        // Get user ID
        const userResponse = await axios.get(
            `https://api.twitter.com/2/users/by/username/${username}`,
            {
                headers: { 'Authorization': `Bearer ${config.twitterBearerToken}` },
                timeout: 10000
            }
        );

        const userId = userResponse.data.data?.id;
        if (!userId) {
            console.error(`❌ User not found: @${username}`);
            return [];
        }

        await new Promise(r => setTimeout(r, 500));

        // Fetch tweets
        const tweetsResponse = await axios.get(
            `https://api.twitter.com/2/users/${userId}/tweets`,
            {
                headers: { 'Authorization': `Bearer ${config.twitterBearerToken}` },
                params: {
                    max_results: 5,
                    'tweet.fields': 'created_at,public_metrics,referenced_tweets,attachments',
                    'expansions': 'attachments.media_keys',
                    'media.fields': 'url,preview_image_url'
                },
                timeout: 10000
            }
        );

        recordApiSuccess();

        const tweets = tweetsResponse.data.data || [];
        const media = tweetsResponse.data.includes?.media || [];

        return tweets.map(tweet => {
            const tweetMedia = media.find(m => tweet.attachments?.media_keys?.includes(m.media_key));
            return {
                id: tweet.id,
                text: tweet.text,
                username,
                createdAt: tweet.created_at,
                url: `https://twitter.com/${username}/status/${tweet.id}`,
                isReply: tweet.referenced_tweets?.some(rt => rt.type === 'replied_to'),
                isRetweet: tweet.referenced_tweets?.some(rt => rt.type === 'retweeted'),
                isQuote: tweet.referenced_tweets?.some(rt => rt.type === 'quoted'),
                likes: tweet.public_metrics?.like_count,
                retweets: tweet.public_metrics?.retweet_count,
                image: tweetMedia?.url || tweetMedia?.preview_image_url
            };
        });
    } catch (error) {
        const status = error.response?.status;
        console.error(`❌ Twitter API error for @${username}:`, error.response?.data || error.message);
        if (status === 429) recordApiFailure();
        return [];
    }
}

// Main check function
async function checkForNewTweets() {
    console.log(`\n🔍 Checking for new tweets at ${new Date().toLocaleTimeString()}`);
    
    for (const username of config.twitterUsernames) {
        console.log(`\n--- @${username} ---`);
        
        const tweets = await fetchTweets(username);
        
        if (tweets.length === 0) {
            console.log('⚠️ No tweets fetched (rate limited or error)');
            continue;
        }

        const newTweets = tweets.filter(t => !processedTweets.has(t.id)).reverse();

        if (newTweets.length === 0) {
            console.log('✓ No new tweets');
            continue;
        }

        console.log(`🆕 ${newTweets.length} new tweet(s)`);
        const userProfile = await fetchUserProfile(username);

        for (const tweet of newTweets) {
            const embed = createTweetEmbed(tweet, userProfile);
            if (await sendToDiscord(embed, userProfile)) {
                processedTweets.add(tweet.id);
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    saveProcessedTweets(processedTweets);
}

// Start
async function start() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('   Twitter to Discord Bot');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`📌 Accounts: ${config.twitterUsernames.map(u => '@' + u).join(', ')}`);
    console.log(`⏱️  Interval: ${config.checkIntervalMinutes} minutes`);
    console.log(`💬 Discord: ${config.discordWebhookUrl ? '✅' : '❌'}`);
    console.log(`🔑 Twitter: ${config.twitterBearerToken ? '✅' : '❌'}`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    console.log('💡 Twitter Free Tier = 1,500 tweets/month');
    console.log('   Recommended: 1 account @ 60+ min intervals');
    console.log('═══════════════════════════════════════════════════════\n');

    if (!config.discordWebhookUrl) {
        console.error('❌ DISCORD_WEBHOOK_URL required!');
        process.exit(1);
    }
    if (!config.twitterBearerToken) {
        console.error('❌ TWITTER_BEARER_TOKEN required!');
        process.exit(1);
    }

    await checkForNewTweets();
    setInterval(checkForNewTweets, config.checkIntervalMinutes * 60 * 1000);
    console.log(`\n⏰ Next check in ${config.checkIntervalMinutes} minutes...`);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    saveProcessedTweets(processedTweets);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down...');
    saveProcessedTweets(processedTweets);
    process.exit(0);
});

// Start the bot
start().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
