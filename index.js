require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

// Configuration - Support multiple accounts (comma-separated)
const config = {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    twitterBearerToken: process.env.TWITTER_BEARER_TOKEN,
    // Support comma-separated usernames
    twitterUsernames: (process.env.TWITTER_USERNAMES || process.env.TWITTER_USERNAME || 'simon_hypixel').split(',').map(u => u.trim()),
    checkIntervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5,
    useNitter: process.env.USE_NITTER === 'true',
    nitterInstance: process.env.NITTER_INSTANCE || 'nitter.privacydev.net'
};

// File to store processed tweet IDs
const PROCESSED_TWEETS_FILE = path.join(__dirname, 'processed_tweets.json');

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

// Cache for user profile data (keyed by username)
let cachedUserProfiles = {};

// Discord embed colors
const COLORS = {
    tweet: 0x1DA1F2,      // Twitter blue
    reply: 0x657786,      // Gray for replies
    retweet: 0x17BF63,    // Green for retweets
    quote: 0xFFAD1F       // Orange for quote tweets
};

// Fetch user profile (name and avatar) for a specific username
async function fetchUserProfile(username) {
    if (cachedUserProfiles[username]) {
        return cachedUserProfiles[username];
    }

    if (!config.twitterBearerToken) {
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
                }
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
            
            console.log(`✅ Loaded profile for ${user.name} (@${user.username})`);
            return cachedUserProfiles[username];
        }
    } catch (error) {
        console.error(`❌ Error fetching user profile for @${username}:`, error.response?.data || error.message);
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
            username: userProfile?.name || 'Twitter Bot',
            avatar_url: userProfile?.profileImageUrl || 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
            embeds: [embed]
        });
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

// Fetch tweets using Twitter API v2 for a specific username
async function fetchTweetsFromAPI(username) {
    if (!config.twitterBearerToken) {
        console.log('⚠️ No Twitter Bearer Token, skipping API fetch');
        return [];
    }

    try {
        // First, get user ID
        const userResponse = await axios.get(
            `https://api.twitter.com/2/users/by/username/${username}`,
            {
                headers: { 'Authorization': `Bearer ${config.twitterBearerToken}` }
            }
        );

        const userId = userResponse.data.data?.id;
        if (!userId) {
            console.error(`❌ Could not find Twitter user: ${username}`);
            return [];
        }

        // Fetch recent tweets
        const tweetsResponse = await axios.get(
            `https://api.twitter.com/2/users/${userId}/tweets`,
            {
                headers: { 'Authorization': `Bearer ${config.twitterBearerToken}` },
                params: {
                    max_results: 10,
                    'tweet.fields': 'created_at,public_metrics,referenced_tweets,attachments',
                    'expansions': 'attachments.media_keys,referenced_tweets.id',
                    'media.fields': 'url,preview_image_url'
                }
            }
        );

        const tweets = tweetsResponse.data.data || [];
        const media = tweetsResponse.data.includes?.media || [];

        return tweets.map(tweet => {
            const tweetMedia = media.find(m => 
                tweet.attachments?.media_keys?.includes(m.media_key)
            );

            return {
                id: tweet.id,
                text: tweet.text,
                username: username,
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
        console.error(`❌ Error fetching from Twitter API for @${username}:`, error.response?.data || error.message);
        return [];
    }
}

// Fetch tweets using Nitter RSS (no API key needed) for a specific username
async function fetchTweetsFromNitter(username) {
    const parser = new Parser({
        customFields: {
            item: ['media:content', 'media:thumbnail']
        }
    });

    // Try multiple Nitter instances
    const nitterInstances = [
        config.nitterInstance,
        'nitter.privacydev.net',
        'nitter.poast.org',
        'nitter.net'
    ];

    for (const instance of nitterInstances) {
        try {
            console.log(`📡 Trying Nitter instance: ${instance} for @${username}`);
            const rssUrl = `https://${instance}/${username}/rss`;
            
            const feed = await parser.parseURL(rssUrl);
            
            if (!feed.items || feed.items.length === 0) {
                console.log(`⚠️ No items from ${instance} for @${username}`);
                continue;
            }

            console.log(`✅ Got ${feed.items.length} items from ${instance} for @${username}`);

            return feed.items.map(item => {
                // Extract image from content if present
                let image = null;
                if (item.content) {
                    const imgMatch = item.content.match(/<img[^>]+src="([^"]+)"/);
                    if (imgMatch) {
                        image = imgMatch[1];
                    }
                }

                // Clean up the content (remove HTML tags)
                let text = item.content || item.contentSnippet || item.title || '';
                text = text.replace(/<[^>]*>/g, '').trim();

                // Extract tweet ID from link
                const tweetIdMatch = item.link?.match(/status\/(\d+)/);
                const tweetId = tweetIdMatch ? tweetIdMatch[1] : item.guid;

                return {
                    id: tweetId,
                    text: text,
                    username: username,
                    createdAt: item.pubDate || item.isoDate,
                    url: item.link?.replace(instance, 'twitter.com') || `https://twitter.com/${username}`,
                    isReply: text.startsWith('@') || item.title?.includes('replying to'),
                    isRetweet: text.startsWith('RT @') || item.title?.startsWith('RT'),
                    isQuote: false,
                    image: image
                };
            });
        } catch (error) {
            console.error(`❌ Error with ${instance} for @${username}:`, error.message);
            continue;
        }
    }

    console.error(`❌ All Nitter instances failed for @${username}`);
    return [];
}

// Check tweets for a single user
async function checkTweetsForUser(username) {
    console.log(`\n🔍 Checking tweets from @${username}...`);
    
    let tweets = [];

    // Try Twitter API first, then fall back to Nitter
    if (!config.useNitter && config.twitterBearerToken) {
        tweets = await fetchTweetsFromAPI(username);
    }
    
    if (tweets.length === 0) {
        console.log(`📡 Using Nitter RSS feed for @${username}...`);
        tweets = await fetchTweetsFromNitter(username);
    }

    if (tweets.length === 0) {
        console.log(`⚠️ No tweets found for @${username}`);
        return 0;
    }

    console.log(`📊 Found ${tweets.length} tweets from @${username}`);

    // Process new tweets (oldest first so Discord shows them in order)
    const newTweets = tweets
        .filter(tweet => !processedTweets.has(tweet.id))
        .reverse();

    if (newTweets.length === 0) {
        console.log(`✓ No new tweets from @${username}`);
        return 0;
    }

    console.log(`🆕 ${newTweets.length} new tweet(s) from @${username}`);

    // Fetch user profile for embed
    const userProfile = await fetchUserProfile(username);

    for (const tweet of newTweets) {
        const embed = createTweetEmbed(tweet, userProfile);
        const success = await sendToDiscord(embed, userProfile);
        
        if (success) {
            processedTweets.add(tweet.id);
        }

        // Small delay between messages to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return newTweets.length;
}

// Main function to check for new tweets from all users
async function checkForNewTweets() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`🔄 Checking ${config.twitterUsernames.length} account(s)...`);
    console.log('═══════════════════════════════════════════════════════');
    
    let totalNew = 0;

    for (const username of config.twitterUsernames) {
        const newCount = await checkTweetsForUser(username);
        totalNew += newCount;
        
        // Small delay between users to avoid rate limits
        if (config.twitterUsernames.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Save processed tweets
    saveProcessedTweets(processedTweets);
    
    console.log(`\n📈 Total new tweets posted: ${totalNew}`);
}

// Startup
async function start() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('   Twitter to Discord Bot - Multi-Account');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`📌 Monitoring ${config.twitterUsernames.length} account(s):`);
    config.twitterUsernames.forEach(u => console.log(`   • @${u}`));
    console.log(`⏱️  Check interval: ${config.checkIntervalMinutes} minutes`);
    console.log(`🔧 Using: ${config.useNitter ? 'Nitter RSS' : 'Twitter API'}`);
    console.log(`💬 Discord webhook: ${config.discordWebhookUrl ? '✅ Configured' : '❌ Not set!'}`);
    console.log('═══════════════════════════════════════════════════════\n');

    if (!config.discordWebhookUrl) {
        console.error('❌ DISCORD_WEBHOOK_URL is required! Please set it in .env file');
        process.exit(1);
    }

    // Fetch and display user profiles at startup
    for (const username of config.twitterUsernames) {
        const userProfile = await fetchUserProfile(username);
        if (userProfile.name) {
            console.log(`👤 ${userProfile.name} (@${userProfile.username}) - ${userProfile.profileImageUrl ? '✅ Avatar loaded' : '❌ Default avatar'}`);
        }
    }

    // Initial check
    await checkForNewTweets();

    // Schedule regular checks
    const intervalMs = config.checkIntervalMinutes * 60 * 1000;
    setInterval(checkForNewTweets, intervalMs);

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
