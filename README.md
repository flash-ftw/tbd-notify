# NFT Notify Bot

A Discord bot that allows users to subscribe to NFT collections and receive real-time notifications about listings, sales, and other events.

## Features

- Subscribe to up to 3 NFT collections
- Real-time notifications for:
  - New listings
  - Sales
  - Transfers
  - Offers
  - Bids
  - Metadata updates
  - Cancellations
- Beautiful embeds with images and details
- Easy subscription management

## Commands

- `!subscribe <collection-slug>` - Subscribe to a collection
- `!unsubscribe <collection-slug>` - Unsubscribe from a collection
- `!subscriptions` - View your current subscriptions

## How to Use

1. Find the collection slug you want to subscribe to (e.g., "boredapeyachtclub")
2. Use `!subscribe boredapeyachtclub` to subscribe
3. You'll receive notifications in your DMs when events occur
4. Use `!unsubscribe boredapeyachtclub` to stop receiving notifications

## Event Types

The bot monitors the following events:
- `item_listed` - New NFT listings
- `item_sold` - NFT sales
- `item_transferred` - NFT transfers
- `item_received_offer` - New offers
- `item_received_bid` - New bids
- `item_metadata_updated` - Metadata changes
- `item_cancelled` - Listing cancellations

## Example Collection Slugs

- boredapeyachtclub
- doodles-official
- azuki
- cryptopunks
- moonbirds

## Support

For support or questions, please contact the bot administrator. "# tbd-notify" 
