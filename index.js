require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ActivityType, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } = require('discord.js');
const WebSocket = require('ws');
const fs = require('fs');

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Update the subscription tracking
const userSubscriptions = new Map();
const pendingSubscriptions = new Map();
const subscriptionRefs = new Map();
const activeCollections = new Set();
const eventFilters = new Map();
let ws = null;
let isWsConnected = false;
let heartbeatInterval = null;
let reconnectInterval = null;
let currentRef = 0;
const RECONNECT_DELAY = 5000; // 5 seconds
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_BACKOFF = 30000; // 30 seconds
const HANDSHAKE_TIMEOUT = 10000; // 10 seconds
let reconnectTimeout = null;
const SUBSCRIPTION_DELAY = 2000; // 2 seconds delay before subscribing
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Valid event types
const VALID_EVENTS = [
    'item_listed',
    'item_sold',
    'item_transferred',
    'item_received_offer',
    'item_received_bid',
    'item_metadata_updated',
    'item_cancelled'
];

// Event type constants with emojis and colors
const EVENT_TYPES = {
    item_listed: { emoji: '🆕', color: '#3498db', name: 'New Listing' },
    item_sold: { emoji: '💰', color: '#2ecc71', name: 'Item Sold' },
    item_transferred: { emoji: '🔄', color: '#9b59b6', name: 'Transfer' },
    item_received_offer: { emoji: '💎', color: '#f1c40f', name: 'New Offer' },
    item_received_bid: { emoji: '🎯', color: '#e67e22', name: 'New Bid' },
    item_metadata_updated: { emoji: '📝', color: '#34495e', name: 'Metadata Update' },
    item_cancelled: { emoji: '❌', color: '#e74c3c', name: 'Listing Cancelled' }
};

// Update the BRANDING object
const BRANDING = {
    name: 'Horus',
    author: 'TBD Intern',
    color: '#7289DA', // Discord's brand color
    footer: 'Powered by TBD',
    icon: 'https://i.imgur.com/6J2SUrn.png', // Horus logo
    website: 'https://tbd.website' // Replace with actual website
};

// Update the loadSubscriptions function
function loadSubscriptions() {
    try {
        if (fs.existsSync('subscriptions.json')) {
            const rawData = fs.readFileSync('subscriptions.json', 'utf8');
            console.log('Loading subscriptions from file...');
            
            const data = JSON.parse(rawData);
            
            // Clear existing data
            userSubscriptions.clear();
            eventFilters.clear();
            activeCollections.clear();
            subscriptionRefs.clear();
            
            // Load subscriptions
            if (data.subscriptions) {
                for (const [userId, subscriptions] of Object.entries(data.subscriptions)) {
                    if (Array.isArray(subscriptions)) {
                        const validSubscriptions = subscriptions.filter(slug => 
                            slug && typeof slug === 'string' && isValidCollectionSlug(slug)
                        );
                        if (validSubscriptions.length > 0) {
                            userSubscriptions.set(userId, validSubscriptions);
                            validSubscriptions.forEach(slug => {
                                activeCollections.add(slug);
                                console.log(`✅ Loaded collection ${slug} for user ${userId}`);
                            });
                        }
                    }
                }
            }
            
            // Load event filters
            if (data.eventFilters) {
                for (const [userId, filters] of Object.entries(data.eventFilters)) {
                    if (Array.isArray(filters)) {
                        const validFilters = filters.filter(event => VALID_EVENTS.includes(event));
                        if (validFilters.length > 0) {
                            eventFilters.set(userId, new Set(validFilters));
                            console.log(`✅ Loaded filters for user ${userId}:`, Array.from(validFilters));
                        }
                    }
                }
            }
            
            console.log(`✅ Loaded ${activeCollections.size} active collections and ${eventFilters.size} event filters`);
            console.log('Active collections:', Array.from(activeCollections));
            console.log('User subscriptions:', Object.fromEntries(userSubscriptions));
            
            // Immediately resubscribe to all collections
            if (ws && ws.readyState === WebSocket.OPEN) {
                resubscribeToCollections();
            }
        } else {
            console.log('No subscriptions file found, starting fresh');
        }
    } catch (error) {
        console.error('❌ Error loading subscriptions:', error);
        userSubscriptions.clear();
        eventFilters.clear();
        activeCollections.clear();
        subscriptionRefs.clear();
    }
}

// Save subscriptions to file
function saveSubscriptions() {
    try {
        const data = {
            subscriptions: {},
            eventFilters: {}
        };
        
        // Save user subscriptions
        for (const [userId, subscriptions] of userSubscriptions.entries()) {
            if (Array.isArray(subscriptions) && subscriptions.length > 0) {
                data.subscriptions[userId] = subscriptions;
                // Ensure collections are in activeCollections
                subscriptions.forEach(slug => activeCollections.add(slug));
            }
        }
        
        // Save event filters
        for (const [userId, filters] of eventFilters.entries()) {
            if (filters instanceof Set && filters.size > 0) {
                data.eventFilters[userId] = Array.from(filters);
            }
        }
        
        const jsonData = JSON.stringify(data, null, 2);
        fs.writeFileSync('subscriptions.json', jsonData);
        
        console.log(`✅ Saved ${Object.keys(data.subscriptions).length} user subscriptions and ${Object.keys(data.eventFilters).length} event filters`);
        console.log('Active collections:', Array.from(activeCollections));
        console.log('Saved data:', jsonData);
        
        // Immediately resubscribe to all collections after saving
        if (ws && ws.readyState === WebSocket.OPEN) {
            resubscribeToCollections();
        }
    } catch (error) {
        console.error('❌ Error saving subscriptions:', error);
    }
}

// OpenSea WebSocket connection
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const WS_URL = `wss://stream.openseabeta.com/socket/websocket?token=${OPENSEA_API_KEY}`;

// Connect to OpenSea WebSocket
function connectToOpenSea() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('WebSocket already connected');
        return;
    }

    // Clear any existing timeouts and intervals
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    if (ws) {
        try {
            ws.removeAllListeners();
            ws.terminate();
        } catch (error) {
            console.error('Error cleaning up previous WebSocket:', error);
        }
    }

    console.log('Connecting to OpenSea WebSocket...');
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: 'Connecting to OpenSea...',
            type: ActivityType.Custom
        }]
    });

    try {
        ws = new WebSocket(WS_URL, {
            handshakeTimeout: HANDSHAKE_TIMEOUT,
            maxRetries: 3,
            headers: {
                'User-Agent': 'Horus-NFT-Notifier/1.0',
                'Origin': 'https://opensea.io'
            }
        });

        // Set up connection timeout
        const connectionTimeout = setTimeout(() => {
            if (ws && ws.readyState !== WebSocket.OPEN) {
                console.log('Connection timeout, attempting to reconnect...');
                ws.terminate();
                reconnect();
            }
        }, HANDSHAKE_TIMEOUT);

        ws.on('open', () => {
            clearTimeout(connectionTimeout);
            console.log('Connected to OpenSea WebSocket');
            isWsConnected = true;
            connectionAttempts = 0;
            
            client.user.setPresence({
                status: 'online',
                activities: [{
                    name: 'Monitoring NFTs',
                    type: ActivityType.Watching
                }]
            });

            // Send initial heartbeat
            setTimeout(() => {
                try {
                    ws.send(JSON.stringify({
                        topic: "phoenix",
                        event: "heartbeat",
                        payload: {},
                        ref: 0
                    }));
                    console.log('Sent initial heartbeat');
                } catch (error) {
                    console.error('Error sending initial heartbeat:', error);
                }
            }, 1000);

            // Set up heartbeat interval
            heartbeatInterval = setInterval(() => {
                if (isWsConnected && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({
                            topic: "phoenix",
                            event: "heartbeat",
                            payload: {},
                            ref: 0
                        }));
                    } catch (error) {
                        console.error('Error sending heartbeat:', error);
                        reconnect();
                    }
                }
            }, HEARTBEAT_INTERVAL);

            // Wait before subscribing to ensure connection is stable
            setTimeout(() => {
                console.log('Starting subscription process...');
                loadSubscriptions();
                resubscribeToCollections();
            }, SUBSCRIPTION_DELAY);
        });

        ws.on('error', (error) => {
            clearTimeout(connectionTimeout);
            console.error('WebSocket error:', error);
            isWsConnected = false;
            client.user.setPresence({
                status: 'dnd',
                activities: [{
                    name: 'Connection Error',
                    type: ActivityType.Custom
                }]
            });
            reconnect();
        });

        ws.on('close', (code, reason) => {
            clearTimeout(connectionTimeout);
            console.log(`WebSocket connection closed with code ${code} and reason: ${reason}`);
            isWsConnected = false;
            client.user.setPresence({
                status: 'idle',
                activities: [{
                    name: 'Reconnecting...',
                    type: ActivityType.Custom
                }]
            });
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            reconnect();
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                console.log('📥 Received WebSocket message:', message.event);
                
                if (message.event === 'phx_reply') {
                    const { status, response } = message.payload;
                    if (status === 'ok') {
                        console.log(`✅ Successfully processed subscription event for ref ${message.ref}`);
                    } else {
                        console.error(`❌ Error processing subscription event for ref ${message.ref}:`, response);
                    }
                    return;
                }

                if (message.event === 'phx_close') {
                    console.log(`ℹ️ Connection closed for topic: ${message.topic}`);
                    return;
                }

                handleOpenSeaEvent(message);
            } catch (error) {
                console.error('❌ Error parsing WebSocket message:', error);
            }
        });
    } catch (error) {
        console.error('Error creating WebSocket:', error);
        reconnect();
    }
}

// Handle reconnection with exponential backoff
function reconnect() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    connectionAttempts++;
    if (connectionAttempts <= MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(RECONNECT_DELAY * Math.pow(2, connectionAttempts - 1), MAX_BACKOFF);
        console.log(`Attempting to reconnect in ${delay/1000} seconds... (Attempt ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        
        reconnectTimeout = setTimeout(() => {
            connectToOpenSea();
        }, delay);
    } else {
        console.log('Max reconnection attempts reached. Please restart the bot.');
        client.user.setPresence({
            status: 'dnd',
            activities: [{
                name: 'Connection Failed',
                type: ActivityType.Custom
            }]
        });
    }
}

// Update the handleOpenSeaEvent function
function handleOpenSeaEvent(event) {
    if (!event.payload || !event.payload.payload) {
        console.log('❌ Invalid event payload:', event);
        return;
    }

    const payload = event.payload.payload;
    const collectionSlug = payload.collection?.slug;
    if (!collectionSlug) {
        console.log('❌ Event missing collection slug:', event);
        return;
    }

    console.log(`📥 Received event for collection ${collectionSlug}:`, {
        eventType: event.event,
        tokenId: payload.item?.token_id,
        price: payload.base_price || payload.sale_price
    });

    // Find all users subscribed to this collection
    for (const [userId, subscriptions] of userSubscriptions.entries()) {
        if (subscriptions.includes(collectionSlug)) {
            // Get user's event filters
            const userFilters = eventFilters.get(userId) || new Set(VALID_EVENTS);
            
            console.log(`Processing event for user ${userId}:`, {
                eventType: event.event,
                userFilters: Array.from(userFilters),
                matchesFilter: userFilters.has(event.event)
            });
            
            // Check if event type matches user's filters
            if (userFilters.has(event.event)) {
                console.log(`✅ Sending notification to user ${userId} for event: ${event.event}`);
                sendNotification(userId, event);
            } else {
                console.log(`❌ Event ${event.event} filtered out for user ${userId}`);
            }
        }
    }
}

// Update the resubscribeToCollections function
function resubscribeToCollections() {
    if (!isWsConnected || !ws || ws.readyState !== WebSocket.OPEN) {
        console.log('❌ Cannot resubscribe: WebSocket not connected');
        return;
    }

    console.log('🔄 Resubscribing to active collections...');
    console.log(`Found ${activeCollections.size} active collections to resubscribe to`);
    console.log('Active collections:', Array.from(activeCollections));
    
    // Clear existing subscriptions
    subscriptionRefs.clear();
    
    // Subscribe to each collection with a delay between subscriptions
    let index = 0;
    const collections = Array.from(activeCollections);
    
    const subscribeNext = () => {
        if (index < collections.length) {
            const collectionSlug = collections[index];
            try {
                const ref = ++currentRef;
                subscriptionRefs.set(collectionSlug, ref);
                
                console.log(`🔄 Subscribing to collection: ${collectionSlug}`);
                ws.send(JSON.stringify({
                    topic: `collection:${collectionSlug}`,
                    event: "phx_join",
                    payload: {},
                    ref: ref
                }));

                // Wait before subscribing to the next collection
                setTimeout(subscribeNext, 500);
            } catch (error) {
                console.error(`❌ Error subscribing to collection ${collectionSlug}:`, error);
                setTimeout(subscribeNext, 500);
            }
            index++;
        } else {
            console.log('✅ Finished resubscribing to all collections');
        }
    };

    subscribeNext();
}

// Send notification to user
async function sendNotification(userId, event) {
    try {
        console.log(`Attempting to send notification to user ${userId}...`);
        const user = await client.users.fetch(userId);
        if (!user) {
            console.error(`❌ User ${userId} not found`);
            return;
        }

        const { embed, components } = createEmbed(event);
        await user.send({
            embeds: [embed],
            components: components
        });
        console.log(`✅ Successfully sent notification to user ${userId}`);
    } catch (error) {
        console.error(`❌ Failed to send notification to user ${userId}:`, error);
    }
}

// Create embed for event
function createEmbed(event) {
    const payload = event.payload.payload;
    const eventType = EVENT_TYPES[event.event] || { emoji: '📢', color: '#95a5a6', name: 'Event' };
    
    const embed = new EmbedBuilder()
        .setColor(eventType.color)
        .setTimestamp()
        .setFooter({
            text: `${BRANDING.footer} • ${BRANDING.name}`,
            iconURL: BRANDING.icon
        });

    // Set title with emoji and branding
    embed.setTitle(`${eventType.emoji} ${eventType.name}`);

    // Add collection information
    if (payload.collection) {
        const collectionName = payload.collection.name || payload.collection.slug || 'Unknown Collection';
        const collectionSlug = payload.collection.slug;
        const verifiedBadge = payload.collection.verified ? '✅' : '';
        const collectionUrl = `https://opensea.io/collection/${collectionSlug}`;
        
        embed.setAuthor({
            name: `${collectionName} ${verifiedBadge}`,
            url: collectionUrl,
            iconURL: payload.collection.image_url
        });

        // Add floor price for collection
        if (payload.collection.stats?.floor_price) {
            embed.addFields({
                name: 'Floor Price',
                value: `${formatPrice(payload.collection.stats.floor_price)} ETH`,
                inline: true
            });
        }
    }

    // Add token information
    if (payload.item) {
        const tokenName = payload.item.metadata?.name || `Token #${payload.item.token_id}`;
        const tokenId = payload.item.token_id;
        const contractAddress = payload.item.contract_address;
        const tokenUrl = payload.item.permalink;
        
        let description = `**${tokenName}**`;
        
        if (tokenId) {
            description += `\nToken ID: ${tokenId}`;
        }
        
        if (contractAddress) {
            description += `\nContract: \`${contractAddress}\``;
        }

        // Add rarity rank if available
        if (payload.item.rarity_data?.rank) {
            description += `\nRarity Rank: #${payload.item.rarity_data.rank}`;
        }
        
        embed.setDescription(description);
        
        if (payload.item.metadata?.image_url) {
            embed.setImage(payload.item.metadata.image_url);
        }
        
        if (tokenUrl) {
            embed.setURL(tokenUrl);
        }
    }

    // Add event-specific fields
    if (event.event === 'item_listed') {
        // Add listing price
        if (payload.base_price) {
            embed.addFields({
                name: 'Listing Price',
                value: `${formatPrice(payload.base_price)} ETH`,
                inline: true
            });
        }

        // Add listing duration/expiration
        if (payload.expiration_date) {
            const expirationDate = new Date(payload.expiration_date);
            embed.addFields({
                name: 'Expires',
                value: `<t:${Math.floor(expirationDate.getTime() / 1000)}:R>`,
                inline: true
            });
        }

        // Add seller information
        if (payload.maker) {
            embed.addFields({
                name: 'Seller',
                value: `[${formatAddress(payload.maker)}](https://opensea.io/${payload.maker})`,
                inline: true
            });
        }
    } else if (event.event === 'item_sold') {
        // Add sale price
        if (payload.sale_price) {
            embed.addFields({
                name: 'Sale Price',
                value: `${formatPrice(payload.sale_price)} ETH`,
                inline: true
            });
        }

        // Add transaction timestamp
        if (payload.transaction) {
            const txDate = new Date(payload.transaction.timestamp);
            embed.addFields({
                name: 'Sold',
                value: `<t:${Math.floor(txDate.getTime() / 1000)}:R>`,
                inline: true
            });
        }

        // Add buyer and seller information
        if (payload.maker) {
            embed.addFields({
                name: 'Seller',
                value: `[${formatAddress(payload.maker)}](https://opensea.io/${payload.maker})`,
                inline: true
            });
        }
        if (payload.taker) {
            embed.addFields({
                name: 'Buyer',
                value: `[${formatAddress(payload.taker)}](https://opensea.io/${payload.taker})`,
                inline: true
            });
        }
    }

    // Create action rows for buttons
    const components = [];

    // First row for URL buttons
    const urlButtonRow = new ActionRowBuilder();
    
    // Add View Token button if token URL exists
    if (payload.item?.permalink) {
        urlButtonRow.addComponents(
            new ButtonBuilder()
                .setLabel('View Token')
                .setStyle(ButtonStyle.Link)
                .setURL(payload.item.permalink)
        );
    }

    // Add View Collection button if collection exists
    if (payload.collection?.slug) {
        urlButtonRow.addComponents(
            new ButtonBuilder()
                .setLabel('View Collection')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://opensea.io/collection/${payload.collection.slug}`)
        );
    }

    if (urlButtonRow.components.length > 0) {
        components.push(urlButtonRow);
    }

    // Second row for profile and action buttons
    const profileButtonRow = new ActionRowBuilder();

    // Add profile buttons based on event type
    if (event.event === 'item_listed') {
        if (payload.maker) {
            profileButtonRow.addComponents(
                new ButtonBuilder()
                    .setLabel('View Seller')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://opensea.io/${payload.maker}`)
            );
        }
    } else if (event.event === 'item_sold') {
        if (payload.maker) {
            profileButtonRow.addComponents(
                new ButtonBuilder()
                    .setLabel('View Seller')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://opensea.io/${payload.maker}`)
            );
        }
        if (payload.taker) {
            profileButtonRow.addComponents(
                new ButtonBuilder()
                    .setLabel('View Buyer')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://opensea.io/${payload.taker}`)
            );
        }
    }

    // Add action buttons for listings
    if (event.event === 'item_listed' && payload.item?.permalink) {
        profileButtonRow.addComponents(
            new ButtonBuilder()
                .setLabel('Make Offer')
                .setStyle(ButtonStyle.Link)
                .setURL(`${payload.item.permalink}/offers`)
        );
        profileButtonRow.addComponents(
            new ButtonBuilder()
                .setLabel('Buy Now')
                .setStyle(ButtonStyle.Link)
                .setURL(payload.item.permalink)
        );
    }

    if (profileButtonRow.components.length > 0) {
        components.push(profileButtonRow);
    }

    // Third row for collections management
    const collectionsButtonRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('view_collections')
                .setLabel('View Collections')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📋')
        );

    components.push(collectionsButtonRow);

    return { embed, components };
}

// Validate collection slug
function isValidCollectionSlug(slug) {
    return typeof slug === 'string' && 
           slug.length > 0 && 
           /^[a-z0-9-]+$/.test(slug);
}

// Helper functions for formatting
function formatPrice(price, currency = 'ETH') {
    if (!price) return 'N/A';
    const formattedPrice = parseFloat(price).toLocaleString('en-US', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
    });
    return `${formattedPrice} ${currency}`;
}

function formatAddress(address) {
    if (!address) return 'Unknown';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    return `<t:${Math.floor(new Date(timestamp).getTime() / 1000)}:R>`;
}

function getPriceChangeIndicator(price, previousPrice) {
    if (!price || !previousPrice) return '';
    const change = ((price - previousPrice) / previousPrice) * 100;
    if (change > 0) return '📈';
    if (change < 0) return '📉';
    return '➖';
}

function formatPriceChange(price, previousPrice) {
    if (!price || !previousPrice) return '';
    const change = ((price - previousPrice) / previousPrice) * 100;
    const formattedChange = Math.abs(change).toFixed(2);
    return `${change > 0 ? '+' : ''}${formattedChange}%`;
}

// Initialize the bot
client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: `${BRANDING.name} | !help`,
            type: ActivityType.Watching
        }]
    });
    loadSubscriptions();
    connectToOpenSea();

    // Set up auto-reconnect every 5 minutes
    reconnectInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('Performing scheduled reconnect...');
            ws.close();
        }
    }, 5 * 60 * 1000); // 5 minutes
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'subscribe') {
        const collectionSlug = args[0];
        if (!collectionSlug) {
            return message.reply('Please provide a collection slug. Usage: !subscribe <collection-slug> [events]\nAvailable events: ' + VALID_EVENTS.join(', '));
        }

        if (!isValidCollectionSlug(collectionSlug)) {
            return message.reply('Invalid collection slug. Collection slugs can only contain lowercase letters, numbers, and hyphens.');
        }

        // Parse event filters
        const userEvents = new Set();
        if (args.length > 1) {
            const eventArgs = args.slice(1);
            for (const event of eventArgs) {
                if (VALID_EVENTS.includes(event)) {
                    userEvents.add(event);
                } else {
                    return message.reply(`Invalid event type: ${event}. Valid events are: ${VALID_EVENTS.join(', ')}`);
                }
            }
        } else {
            // If no events specified, subscribe to all events
            VALID_EVENTS.forEach(event => userEvents.add(event));
        }

        const userId = message.author.id;
        let subscriptions = userSubscriptions.get(userId) || [];

        if (subscriptions.length >= 3) {
            return message.reply('You have reached the maximum limit of 3 subscriptions.');
        }

        if (subscriptions.includes(collectionSlug)) {
            return message.reply('You are already subscribed to this collection.');
        }

        // Store event filters for this user
        eventFilters.set(userId, userEvents);
        console.log(`Setting event filters for user ${userId}: ${Array.from(userEvents).join(', ')}`);

        // Subscribe to collection
        try {
            const ref = ++currentRef;
            subscriptionRefs.set(collectionSlug, ref);
            activeCollections.add(collectionSlug);

            // Send subscription request to OpenSea
            if (ws && ws.readyState === WebSocket.OPEN) {
                console.log(`Subscribing to collection ${collectionSlug} for user ${userId}`);
                ws.send(JSON.stringify({
                    topic: `collection:${collectionSlug}`,
                    event: "phx_join",
                    payload: {},
                    ref: ref
                }));

                // Wait for confirmation
                const subscriptionPromise = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Subscription timeout'));
                    }, 5000);

                    const handler = (event) => {
                        if (event.event === 'phx_reply' && event.ref === ref) {
                            clearTimeout(timeout);
                            ws.removeListener('message', handler);
                            resolve(event);
                        }
                    };

                    ws.on('message', handler);
                });

                await subscriptionPromise;
                console.log(`✅ Successfully subscribed to collection ${collectionSlug}`);

                subscriptions.push(collectionSlug);
                userSubscriptions.set(userId, subscriptions);
                saveSubscriptions();

                // Create action rows for event filters
                const filterRow = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('event_filters')
                            .setPlaceholder('Select events to filter')
                            .setMinValues(1)
                            .setMaxValues(VALID_EVENTS.length)
                            .addOptions(
                                VALID_EVENTS.map(event => ({
                                    label: EVENT_TYPES[event].name,
                                    description: `Filter ${event} events`,
                                    value: event,
                                    emoji: EVENT_TYPES[event].emoji,
                                    default: userEvents.has(event)
                                }))
                            )
                    );

                const successEmbed = new EmbedBuilder()
                    .setColor(BRANDING.color)
                    .setTitle('Subscription Successful')
                    .setDescription(`You are now subscribed to ${collectionSlug}`)
                    .addFields({
                        name: 'Status',
                        value: '✅ Active and receiving notifications'
                    })
                    .setFooter({
                        text: `${BRANDING.footer} • ${BRANDING.name}`,
                        iconURL: BRANDING.icon
                    });

                message.reply({ 
                    embeds: [successEmbed],
                    components: [filterRow]
                });
            } else {
                console.log(`WebSocket not connected, adding ${collectionSlug} to pending subscriptions`);
                pendingSubscriptions.set(collectionSlug, 'join');
                subscriptions.push(collectionSlug);
                userSubscriptions.set(userId, subscriptions);
                activeCollections.add(collectionSlug);
                saveSubscriptions();
                message.reply(`Successfully subscribed to collection: ${collectionSlug} with events: ${Array.from(userEvents).join(', ')} (will be processed when connection is established)`);
            }
        } catch (error) {
            console.error('Error subscribing to collection:', error);
            message.reply('Failed to subscribe to collection. Please try again later.');
        }
    }

    if (command === 'unsubscribe') {
        const collectionSlug = args[0];
        if (!collectionSlug) {
            return message.reply('Please provide a collection slug. Usage: !unsubscribe <collection-slug>');
        }

        if (!isValidCollectionSlug(collectionSlug)) {
            return message.reply('Invalid collection slug. Collection slugs can only contain lowercase letters, numbers, and hyphens.');
        }

        const userId = message.author.id;
        const subscriptions = userSubscriptions.get(userId) || [];

        if (!subscriptions.includes(collectionSlug)) {
            return message.reply('You are not subscribed to this collection.');
        }

        // Remove from user subscriptions first
        const updatedSubscriptions = subscriptions.filter(slug => slug !== collectionSlug);
        userSubscriptions.set(userId, updatedSubscriptions);

        // Check if collection is still subscribed by other users
        let isCollectionStillSubscribed = false;
        for (const userSubs of userSubscriptions.values()) {
            if (userSubs.includes(collectionSlug)) {
                isCollectionStillSubscribed = true;
                break;
            }
        }

        // If no one is subscribed to this collection anymore, remove from active collections
        if (!isCollectionStillSubscribed) {
            activeCollections.delete(collectionSlug);
            if (ws && ws.readyState === WebSocket.OPEN) {
                const ref = subscriptionRefs.get(collectionSlug);
                if (ref) {
                    ws.send(JSON.stringify({
                        topic: `collection:${collectionSlug}`,
                        event: "phx_leave",
                        payload: {},
                        ref: ref
                    }));
                    subscriptionRefs.delete(collectionSlug);
                }
            }
        }

        saveSubscriptions();

        const successEmbed = new EmbedBuilder()
            .setColor(BRANDING.color)
            .setTitle('Unsubscription Successful')
            .setDescription(`You have been unsubscribed from ${collectionSlug}`)
            .addFields({
                name: '⚠️ Important Note',
                value: 'You may continue to receive notifications for up to 10 minutes as the unsubscription is being processed by OpenSea. This is normal behavior and the notifications will stop automatically.'
            })
            .setFooter({
                text: `${BRANDING.footer} • ${BRANDING.name}`,
                iconURL: BRANDING.icon
            });

        message.reply({ embeds: [successEmbed] });
    }

    if (command === 'subscriptions') {
        const userId = message.author.id;
        const subscriptions = userSubscriptions.get(userId) || [];
        
        if (subscriptions.length === 0) {
            return message.reply('You have no active subscriptions.');
        }

        const subscriptionsEmbed = new EmbedBuilder()
            .setColor(BRANDING.color)
            .setTitle('Your Subscriptions')
            .setDescription(subscriptions.length > 0 
                ? subscriptions.map(sub => `• ${sub}`).join('\n')
                : 'You have no active subscriptions.')
            .setThumbnail(BRANDING.icon)
            .setFooter({
                text: `${BRANDING.footer} • ${BRANDING.name}`,
                iconURL: BRANDING.icon
            });

        // Create action rows for collection management
        const collectionRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('subs_add')
                    .setLabel('Add Collection')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('subs_remove')
                    .setLabel('Remove Collection')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('subs_clear')
                    .setLabel('Clear All')
                    .setStyle(ButtonStyle.Danger)
            );

        message.reply({ embeds: [subscriptionsEmbed], components: [collectionRow] });
    }

    if (command === 'events') {
        const userId = message.author.id;
        const userEvents = eventFilters.get(userId) || new Set(VALID_EVENTS);
        
        const eventsEmbed = new EmbedBuilder()
            .setColor(BRANDING.color)
            .setTitle('Available Events')
            .setDescription('Here are the events you can subscribe to:')
            .setThumbnail(BRANDING.icon)
            .addFields(
                VALID_EVENTS.map(event => ({
                    name: `${EVENT_TYPES[event].emoji} ${EVENT_TYPES[event].name}`,
                    value: `\`${event}\``,
                    inline: true
                }))
            )
            .setFooter({
                text: `${BRANDING.footer} • ${BRANDING.name}`,
                iconURL: BRANDING.icon
            });

        message.reply({ embeds: [eventsEmbed] });
    }

    if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(BRANDING.color)
            .setTitle(`${BRANDING.name} NFT Notifier`)
            .setDescription('A powerful NFT notification bot by TBD Intern')
            .setThumbnail(BRANDING.icon)
            .addFields(
                { name: 'Available Commands', value: 'Here are all the commands you can use:' },
                { name: '!subscribe <collection-slug> [events]', value: 'Subscribe to a collection with optional event filters' },
                { name: '!unsubscribe <collection-slug>', value: 'Unsubscribe from a collection' },
                { name: '!subscriptions', value: 'View your current subscriptions' },
                { name: '!events', value: 'View available event types' },
                { name: '!help', value: 'Show this help message' }
            )
            .setFooter({
                text: `${BRANDING.footer} • ${BRANDING.name}`,
                iconURL: BRANDING.icon
            });

        // Create action rows for buttons
        const mainRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('help_commands')
                    .setLabel('Commands')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('help_status')
                    .setLabel('Status')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('help_settings')
                    .setLabel('Settings')
                    .setStyle(ButtonStyle.Secondary)
            );

        message.reply({ embeds: [helpEmbed], components: [mainRow] });
    }

    if (command === 'setup') {
        // Check if user has admin permissions
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('You need administrator permissions to use this command.');
        }

        const setupEmbed = new EmbedBuilder()
            .setColor(BRANDING.color)
            .setTitle(`${BRANDING.name} NFT Notifier`)
            .setDescription('Welcome to the NFT Notifier! Use the buttons below to manage your subscriptions and notifications.')
            .addFields(
                { name: '📊 Collection Management', value: 'Add, remove, or view your NFT collections' },
                { name: '🔔 Event Filters', value: 'Customize which events you want to be notified about' },
                { name: '❓ Help & Support', value: 'Get started and find answers to common questions' }
            )
            .setThumbnail(BRANDING.icon)
            .setFooter({
                text: `${BRANDING.footer} • ${BRANDING.name}`,
                iconURL: BRANDING.icon
            });

        // Create action rows for buttons
        const mainRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('setup_collections')
                    .setLabel('Manage Collections')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📊'),
                new ButtonBuilder()
                    .setCustomId('setup_events')
                    .setLabel('Event Filters')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🔔'),
                new ButtonBuilder()
                    .setCustomId('setup_help')
                    .setLabel('Help')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('❓')
            );

        await message.channel.send({
            embeds: [setupEmbed],
            components: [mainRow]
        });
    }
});

// Update the interaction handler
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        const [action, subAction] = interaction.customId.split('_');
        const userId = interaction.user.id;

        switch (action) {
            case 'view':
                if (subAction === 'collections') {
                    const subscriptions = userSubscriptions.get(userId) || [];
                    if (subscriptions.length === 0) {
                        await interaction.reply({
                            content: 'You have no active subscriptions.',
                            ephemeral: true
                        });
                        return;
                    }

                    const collectionsEmbed = new EmbedBuilder()
                        .setColor(BRANDING.color)
                        .setTitle('Your Subscriptions')
                        .setDescription(subscriptions.map(sub => `• ${sub}`).join('\n'))
                        .setThumbnail(BRANDING.icon)
                        .setFooter({
                            text: `${BRANDING.footer} • ${BRANDING.name}`,
                            iconURL: BRANDING.icon
                        });

                    await interaction.reply({
                        embeds: [collectionsEmbed],
                        ephemeral: true
                    });
                }
                break;

            case 'subs':
                switch (subAction) {
                    case 'add':
                        const addModal = new ModalBuilder()
                            .setCustomId('add_collection_modal')
                            .setTitle('Add Collection')
                            .addComponents(
                                new ActionRowBuilder().addComponents(
                                    new TextInputBuilder()
                                        .setCustomId('collection_slug')
                                        .setLabel('Collection Slug')
                                        .setStyle(TextInputStyle.Short)
                                        .setPlaceholder('e.g., boredapeyachtclub')
                                        .setRequired(true)
                                )
                            );
                        await interaction.showModal(addModal);
                        break;

                    case 'remove':
                        const userSubs = userSubscriptions.get(userId) || [];
                        if (userSubs.length === 0) {
                            await interaction.reply({
                                content: 'You have no subscriptions to remove.',
                                ephemeral: true
                            });
                            return;
                        }

                        const removeSelect = new StringSelectMenuBuilder()
                            .setCustomId('remove_collection')
                            .setPlaceholder('Select collection to remove')
                            .addOptions(
                                userSubs.map(slug => ({
                                    label: slug,
                                    value: slug
                                }))
                            );

                        const removeRow = new ActionRowBuilder().addComponents(removeSelect);
                        await interaction.reply({
                            content: 'Select a collection to remove:',
                            components: [removeRow],
                            ephemeral: true
                        });
                        break;

                    case 'clear':
                        const confirmRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('clear_confirm')
                                    .setLabel('Confirm Clear All')
                                    .setStyle(ButtonStyle.Danger),
                                new ButtonBuilder()
                                    .setCustomId('clear_cancel')
                                    .setLabel('Cancel')
                                    .setStyle(ButtonStyle.Secondary)
                            );

                        await interaction.reply({
                            content: '⚠️ Are you sure you want to clear all your subscriptions?',
                            components: [confirmRow],
                            ephemeral: true
                        });
                        break;
                }
                break;

            case 'clear':
                if (subAction === 'confirm') {
                    userSubscriptions.delete(userId);
                    eventFilters.delete(userId);
                    saveSubscriptions();
                    await interaction.update({
                        content: '✅ All your subscriptions have been cleared.',
                        components: []
                    });
                } else if (subAction === 'cancel') {
                    await interaction.update({
                        content: 'Operation cancelled.',
                        components: []
                    });
                }
                break;

            case 'help':
                switch (subAction) {
                    case 'commands':
                        const commandsEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Available Commands')
                            .setDescription('Here are all the commands you can use:')
                            .addFields(
                                { name: '!subscribe <collection-slug> [events]', value: 'Subscribe to a collection with optional event filters' },
                                { name: '!unsubscribe <collection-slug>', value: 'Unsubscribe from a collection' },
                                { name: '!subscriptions', value: 'View your current subscriptions' },
                                { name: '!events', value: 'View available event types' },
                                { name: '!help', value: 'Show this help message' }
                            )
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        await interaction.reply({
                            embeds: [commandsEmbed],
                            ephemeral: true
                        });
                        break;

                    case 'status':
                        const statusEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Bot Status')
                            .addFields(
                                { name: 'Connection Status', value: isWsConnected ? '✅ Connected' : '❌ Disconnected', inline: true },
                                { name: 'Active Collections', value: subscriptionRefs.size.toString(), inline: true },
                                { name: 'Total Users', value: userSubscriptions.size.toString(), inline: true },
                                { name: 'Your Subscriptions', value: (userSubscriptions.get(userId) || []).length.toString(), inline: true }
                            )
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        await interaction.reply({
                            embeds: [statusEmbed],
                            ephemeral: true
                        });
                        break;

                    case 'settings':
                        const settingsEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Your Settings')
                            .addFields(
                                { name: 'Event Filters', value: Array.from(eventFilters.get(userId) || []).map(e => EVENT_TYPES[e].name).join(', ') || 'All Events' },
                                { name: 'Subscriptions', value: (userSubscriptions.get(userId) || []).length.toString() }
                            )
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        await interaction.reply({
                            embeds: [settingsEmbed],
                            ephemeral: true
                        });
                        break;

                    case 'guide':
                        const guideEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Quick Start Guide')
                            .setDescription('Get started with the NFT Notifier in 3 easy steps:')
                            .addFields(
                                { name: '1️⃣ Add a Collection', value: 'Use the "Add Collection" button to subscribe to an NFT collection' },
                                { name: '2️⃣ Set Event Filters', value: 'Choose which events you want to be notified about' },
                                { name: '3️⃣ Receive Notifications', value: 'Get instant updates about your favorite NFTs' }
                            )
                            .setThumbnail(BRANDING.icon)
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        await interaction.reply({
                            embeds: [guideEmbed],
                            ephemeral: true
                        });
                        break;

                    case 'faq':
                        const faqEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Frequently Asked Questions')
                            .addFields(
                                { name: '❓ How do I find collection slugs?', value: 'Visit the collection on OpenSea and copy the last part of the URL (e.g., boredapeyachtclub)' },
                                { name: '❓ What events can I filter?', value: 'You can filter listings, sales, transfers, offers, and more' },
                                { name: '❓ How do I manage notifications?', value: 'Use the event filters to customize which notifications you receive' },
                                { name: '❓ Can I subscribe to multiple collections?', value: 'Yes, you can subscribe to up to 3 collections' }
                            )
                            .setThumbnail(BRANDING.icon)
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        await interaction.reply({
                            embeds: [faqEmbed],
                            ephemeral: true
                        });
                        break;
                }
                break;

            case 'filter':
                const userFilters = eventFilters.get(userId) || new Set();
                switch (subAction) {
                    case 'sales':
                        userFilters.clear();
                        userFilters.add('item_sold');
                        eventFilters.set(userId, userFilters);
                        saveSubscriptions();
                        await interaction.update({
                            content: '✅ Set to receive sales notifications only',
                            components: []
                        });
                        break;

                    case 'listings':
                        userFilters.clear();
                        userFilters.add('item_listed');
                        eventFilters.set(userId, userFilters);
                        saveSubscriptions();
                        await interaction.update({
                            content: '✅ Set to receive listing notifications only',
                            components: []
                        });
                        break;

                    case 'all':
                        VALID_EVENTS.forEach(event => userFilters.add(event));
                        eventFilters.set(userId, userFilters);
                        saveSubscriptions();
                        await interaction.update({
                            content: '✅ Set to receive all event notifications',
                            components: []
                        });
                        break;
                }
                break;

            case 'setup':
                switch (subAction) {
                    case 'collections':
                        const collectionsEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Collection Management')
                            .setDescription('Manage your NFT collections and subscriptions')
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        const collectionsRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('subs_add')
                                    .setLabel('Add Collection')
                                    .setStyle(ButtonStyle.Success)
                                    .setEmoji('➕'),
                                new ButtonBuilder()
                                    .setCustomId('subs_remove')
                                    .setLabel('Remove Collection')
                                    .setStyle(ButtonStyle.Danger)
                                    .setEmoji('➖'),
                                new ButtonBuilder()
                                    .setCustomId('view_collections')
                                    .setLabel('View Collections')
                                    .setStyle(ButtonStyle.Primary)
                                    .setEmoji('👁️')
                            );

                        await interaction.reply({
                            embeds: [collectionsEmbed],
                            components: [collectionsRow],
                            ephemeral: true
                        });
                        break;

                    case 'events':
                        const eventsEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Event Filters')
                            .setDescription('Select which events you want to be notified about')
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        const quickFilterRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('filter_sales')
                                    .setLabel('Sales Only')
                                    .setStyle(ButtonStyle.Secondary)
                                    .setEmoji('💰'),
                                new ButtonBuilder()
                                    .setCustomId('filter_listings')
                                    .setLabel('Listings Only')
                                    .setStyle(ButtonStyle.Secondary)
                                    .setEmoji('🆕'),
                                new ButtonBuilder()
                                    .setCustomId('filter_all')
                                    .setLabel('All Events')
                                    .setStyle(ButtonStyle.Secondary)
                                    .setEmoji('📢')
                            );

                        const filterSelect = new StringSelectMenuBuilder()
                            .setCustomId('event_filters')
                            .setPlaceholder('Select events to filter')
                            .setMinValues(1)
                            .setMaxValues(VALID_EVENTS.length)
                            .addOptions(
                                VALID_EVENTS.map(event => ({
                                    label: EVENT_TYPES[event].name,
                                    description: `Filter ${event} events`,
                                    value: event,
                                    emoji: EVENT_TYPES[event].emoji,
                                    default: true
                                }))
                            );

                        const filterRow = new ActionRowBuilder().addComponents(filterSelect);

                        await interaction.reply({
                            embeds: [eventsEmbed],
                            components: [quickFilterRow, filterRow],
                            ephemeral: true
                        });
                        break;

                    case 'help':
                        const helpEmbed = new EmbedBuilder()
                            .setColor(BRANDING.color)
                            .setTitle('Help & Support')
                            .setDescription('Get started with the NFT Notifier')
                            .addFields(
                                { name: 'Quick Start', value: '1. Add a collection\n2. Set your event filters\n3. Receive notifications!' },
                                { name: 'Common Questions', value: '• How do I find collection slugs?\n• What events can I filter?\n• How do I manage notifications?' }
                            )
                            .setFooter({
                                text: `${BRANDING.footer} • ${BRANDING.name}`,
                                iconURL: BRANDING.icon
                            });

                        const helpRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('help_guide')
                                    .setLabel('Quick Start Guide')
                                    .setStyle(ButtonStyle.Primary)
                                    .setEmoji('📖'),
                                new ButtonBuilder()
                                    .setCustomId('help_faq')
                                    .setLabel('FAQ')
                                    .setStyle(ButtonStyle.Secondary)
                                    .setEmoji('❓')
                            );

                        await interaction.reply({
                            embeds: [helpEmbed],
                            components: [helpRow],
                            ephemeral: true
                        });
                        break;
                }
                break;
        }
    } else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'remove_collection') {
            const collectionSlug = interaction.values[0];
            const userId = interaction.user.id;
            const userSubs = userSubscriptions.get(userId) || [];
            const updatedSubs = userSubs.filter(slug => slug !== collectionSlug);
            userSubscriptions.set(userId, updatedSubs);
            saveSubscriptions();

            const unsubEmbed = new EmbedBuilder()
                .setColor(BRANDING.color)
                .setTitle('Unsubscription Successful')
                .setDescription(`You have been unsubscribed from ${collectionSlug}`)
                .addFields({
                    name: '⚠️ Important Notice',
                    value: 'You may continue to receive notifications for up to 10 minutes as the unsubscription is being processed by OpenSea. This is normal behavior and the notifications will stop automatically.'
                })
                .setFooter({
                    text: `${BRANDING.footer} • ${BRANDING.name}`,
                    iconURL: BRANDING.icon
                });

            await interaction.update({
                embeds: [unsubEmbed],
                components: []
            });
        } else if (interaction.customId === 'event_filters') {
            const selectedEvents = new Set(interaction.values);
            const userId = interaction.user.id;
            eventFilters.set(userId, selectedEvents);
            saveSubscriptions();

            const eventList = Array.from(selectedEvents)
                .map(event => `${EVENT_TYPES[event].emoji} ${EVENT_TYPES[event].name}`)
                .join('\n');

            await interaction.update({
                content: `✅ Event filters updated:\n${eventList}`,
                components: []
            });
        }
    } else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'add_collection_modal') {
            const collectionSlug = interaction.fields.getTextInputValue('collection_slug');
            const userId = interaction.user.id;

            if (!isValidCollectionSlug(collectionSlug)) {
                await interaction.reply({
                    content: 'Invalid collection slug. Collection slugs can only contain lowercase letters, numbers, and hyphens.',
                    ephemeral: true
                });
                return;
            }

            const subscriptions = userSubscriptions.get(userId) || [];
            if (subscriptions.length >= 3) {
                await interaction.reply({
                    content: 'You have reached the maximum limit of 3 subscriptions.',
                    ephemeral: true
                });
                return;
            }

            if (subscriptions.includes(collectionSlug)) {
                await interaction.reply({
                    content: 'You are already subscribed to this collection.',
                    ephemeral: true
                });
                return;
            }

            subscriptions.push(collectionSlug);
            userSubscriptions.set(userId, subscriptions);
            saveSubscriptions();

            const successEmbed = new EmbedBuilder()
                .setColor(BRANDING.color)
                .setTitle('Subscription Successful')
                .setDescription(`You are now subscribed to ${collectionSlug}`)
                .setFooter({
                    text: `${BRANDING.footer} • ${BRANDING.name}`,
                    iconURL: BRANDING.icon
                });

            await interaction.reply({
                embeds: [successEmbed],
                ephemeral: true
            });
        }
    }
});

// Clean up on process exit
process.on('SIGINT', () => {
    console.log('Saving subscriptions and cleaning up...');
    saveSubscriptions();
    if (ws) ws.terminate();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (reconnectInterval) clearInterval(reconnectInterval);
    process.exit();
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN); 