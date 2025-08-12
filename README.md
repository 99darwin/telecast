# What is this
Interact with Farcaster from Telegram

# Configuration
Configure the environment variables. 
`cp env.example .env.local`

You'll need a Neynar account, a Redis database, and a Telegram Bot ID.

Message @BotFather on Telegram to set up your bot and get the ID.

You'll also need to add your Farcaster Developer Mnemonic and App ID (the fid of the account you plan to use for the app).

Install dependencies
`npm i`

Start the bot
`npm start`

# Usage
Certain commands related to adding signers are potentially sensitive and I would recommend removal after initial setup or authenticating them in some way. 

| Command | Description |
|---------|-------------|
| `/start` | Initiates the setup process, asks for Farcaster FID |
| `/feed` | Fetches and displays the user's Farcaster For You feed |
| `/cast` | Publishes a new cast to Farcaster |
| `/check_approval` | Verifies if the user's signer connection is approved |
| `/update_signer` | Updates signer information in the database |
| `/check_signer` | Checks the status of an existing signer |
| `/list_signers` | Lists all signers stored in the database |
| `/check_approved_signer` | Checks the status of the approved signer |
| `/get_approval_link` | Generates a Warpcast approval link for the user's signer |
| `/replies` | Checks for replies to the user's casts |
| `/channel_cast` | Publishes a cast to a specific Farcaster channel |
| `/reset_signer` | Resets the user's signer |
