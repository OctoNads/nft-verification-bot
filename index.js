require('dotenv').config();
const { Client, GatewayIntentBits, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Logger Initialization
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot.log' })
    ]
});

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Configuration from Environment Variables
const CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const ONE_HOLDER_ROLE = process.env.ONE_HOLDER_ROLE;
const TWO_HOLDER_ROLE = process.env.TWO_HOLDER_ROLE;
const FIVE_HOLDER_ROLE = process.env.FIVE_HOLDER_ROLE;
const TEN_HOLDER_ROLE = process.env.TEN_HOLDER_ROLE;
const FIFTEEN_HOLDER_ROLE = process.env.FIFTEEN_HOLDER_ROLE;
const TEAM_ADDRESS = process.env.TEAM_ADDRESS.toLowerCase();
const GENESIS_NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { timeout: 30000 }); // Increased timeout to 30 seconds
const erc721Abi = ['function balanceOf(address owner) view returns (uint256)'];
const genesisNftContract = new ethers.Contract(GENESIS_NFT_CONTRACT_ADDRESS, erc721Abi, provider);
const requiredAmount = ethers.parseEther('0.1');
const TIME_LIMIT = 10 * 60 * 1000; // 10 minutes in milliseconds
const MESSAGE_TIMEOUT = 10 * 60 * 1000; // 10 minutes for message deletion
const MARKETPLACE_LINK = 'https://marketplace.monad.xyz/collection/0x51840Af9f4b780556DEdE2C7aDa0d4344034a65f'; // Adjust if needed

// Data Stores
const pendingVerifications = new Map();
const completedVerifications = new Map();
const blockCache = new Map();
const scanningStatus = new Map();
const verifiedGenesisUsersFile = path.join(__dirname, 'verifiedGenesisUsers.json');
const usedTxHashesFile = path.join(__dirname, 'usedTxHashes.json');
let usedTxHashes = new Set();
const messageIdFile = path.join(__dirname, 'messageId.txt');

// Modern Color Scheme
const COLOR_PRIMARY = 0x5865F2; // Discord purple
const COLOR_SUCCESS = 0x57F287; // Green
const COLOR_WARNING = 0xFEE75C; // Yellow
const COLOR_ERROR = 0xED4245; // Red
const COLOR_INFO = 0xEB459E; // Pink
const COLOR_ACCENT = 0x7289DA; // Soft blue
const COLOR_NEUTRAL = 0x36393F; // Dark gray

// Utility Functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry Asynchronous Operations
async function retryAsync(operation, retries = 3, delayMs = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === retries) {
                logger.error(`Operation failed after ${retries} attempts: ${error.message}`);
                return null;
            }
            logger.warn(`Attempt ${attempt} failed: ${error.message}. Retrying in ${delayMs}ms...`);
            await delay(delayMs);
        }
    }
}

// Delete Ephemeral Messages
const deleteMessageAfterTimeout = (interaction, timeout = MESSAGE_TIMEOUT) => {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
            logger.info(`Deleted ephemeral message for interaction ${interaction.id}`);
        } catch (err) {
            logger.error(`Failed to delete ephemeral message: ${err.message}`);
        }
    }, timeout);
};

// Load Verified Genesis Users
function loadVerifiedGenesisUsers() {
    try {
        const data = fs.readFileSync(verifiedGenesisUsersFile, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.info('verifiedGenesisUsers.json not found, starting with empty object');
            return {};
        } else {
            logger.error(`Error reading verifiedGenesisUsers.json: ${err.message}`);
            return {};
        }
    }
}

// Save Verified Genesis Users
function saveVerifiedGenesisUsers(users) {
    try {
        fs.writeFileSync(verifiedGenesisUsersFile, JSON.stringify(users, null, 2));
        logger.info('Successfully saved verified Genesis users');
    } catch (err) {
        logger.error(`Failed to save verified Genesis users: ${err.message}`);
    }
}

// Load Used Transaction Hashes
function loadUsedTxHashes() {
    try {
        const data = fs.readFileSync(usedTxHashesFile, 'utf8');
        return new Set(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.info('usedTxHashes.json not found, starting with empty set');
            return new Set();
        } else {
            logger.error(`Error reading usedTxHashes.json: ${err.message}`);
            return new Set();
        }
    }
}

// Save Used Transaction Hashes
function saveUsedTxHashes() {
    try {
        fs.writeFileSync(usedTxHashesFile, JSON.stringify([...usedTxHashes], null, 2));
        logger.info('Successfully saved used transaction hashes');
    } catch (err) {
        logger.error(`Failed to save usedTxHashes: ${err.message}`);
    }
}

// Check Genesis NFT Ownership (ERC721) - Returns BigInt balance
async function checkGenesisNFTOwnership(walletAddress) {
    return await retryAsync(async () => {
        const balance = await genesisNftContract.balanceOf(walletAddress);
        logger.info(`Genesis NFT balance for ${walletAddress}: ${balance}`);
        return balance;
    });
}

// Get Block with Retry and Caching
async function getBlockWithRetry(blockNumber, retries = 3) {
    if (blockCache.has(blockNumber)) {
        logger.info(`Cache hit for block ${blockNumber}`);
        return blockCache.get(blockNumber);
    }
    let delayMs = 1000;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const block = await provider.getBlock(blockNumber, true);
            blockCache.set(blockNumber, block);
            logger.info(`Fetched and cached block ${blockNumber}`);
            return block;
        } catch (err) {
            logger.error(`Attempt ${attempt} failed for block ${blockNumber}: ${err.message}`);
            if (attempt === retries) throw new Error(`Failed to fetch block ${blockNumber} after ${retries} attempts`);
            await delay(delayMs);
            delayMs *= 2; // Exponential backoff
        }
    }
}

// Verify Transaction by Hash with Retry
async function verifyTxHash(txHash, walletAddress, verificationTimestamp) {
    return await retryAsync(async () => {
        try {
            if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
                logger.warn(`Invalid tx hash format: ${txHash}`);
                return false;
            }
            if (usedTxHashes.has(txHash)) {
                logger.warn(`Transaction hash ${txHash} has already been used for verification`);
                return false;
            }
            const tx = await provider.getTransaction(txHash);
            if (!tx) {
                logger.info(`Transaction ${txHash} not found`);
                return false;
            }
            const receipt = await provider.getTransactionReceipt(txHash);
            if (!receipt || receipt.status !== 1) {
                logger.info(`Receipt for ${txHash} not found or transaction failed`);
                return false;
            }
            const block = await provider.getBlock(receipt.blockNumber);
            const txTimestamp = block.timestamp * 1000;

            const isValid = (
                tx.from.toLowerCase() === walletAddress.toLowerCase() &&
                tx.to && tx.to.toLowerCase() === TEAM_ADDRESS.toLowerCase() &&
                tx.value.toString() === requiredAmount.toString() &&
                txTimestamp >= verificationTimestamp
            );
            logger.info(`Tx ${txHash} verification result: ${isValid}`);
            return isValid;
        } catch (error) {
            logger.error(`Error verifying tx hash ${txHash}: ${error.message}`);
            throw error; // Rethrow to trigger retry
        }
    }, 3, 2000); // 3 retries with 2s delay
}

// Scan Blocks for Transaction
async function scanBlocksForTransaction(userId, walletAddress, verificationTimestamp) {
    const startTime = Date.now();
    const maxDuration = 10 * 60 * 1000; // 10 minutes
    const blockTimeEstimate = 1000; // Estimated block time in ms

    try {
        const latestBlock = await retryAsync(async () => await provider.getBlockNumber());
        const latestBlockData = await retryAsync(async () => await provider.getBlock(latestBlock));
        const latestTimestamp = latestBlockData.timestamp * 1000;
        const timeSinceVerification = (latestTimestamp - verificationTimestamp) / 1000;
        const blocksSinceVerification = Math.ceil(timeSinceVerification / (blockTimeEstimate / 1000));
        const estimatedVerificationBlock = latestBlock - blocksSinceVerification;
        const startBlock = Math.max(estimatedVerificationBlock - 10, 0);

        scanningStatus.set(userId, {
            startBlock,
            latestBlock,
            currentBlock: latestBlock,
            totalBlocks: latestBlock - startBlock + 1,
            startTime: Date.now(),
            status: 'scanning',
            cancel: false
        });

        logger.info(`Scanning blocks ${startBlock} to ${latestBlock} for wallet ${walletAddress}`);
        let txCount = 0;

        for (let i = latestBlock; i >= startBlock; i--) {
            const status = scanningStatus.get(userId);
            if (!status || status.cancel) {
                logger.info(`Scanning for user ${userId} cancelled at block ${i}`);
                scanningStatus.delete(userId);
                return null;
            }
            status.currentBlock = i;
            scanningStatus.set(userId, status);

            const block = await getBlockWithRetry(i);
            if (!block || !block.transactions || block.transactions.length === 0) {
                logger.info(`Block ${block?.number} is empty or invalid`);
                continue;
            }
            const blockTimestamp = block.timestamp * 1000;
            if (blockTimestamp < verificationTimestamp) {
                logger.info(`Block ${block.number} is before verification timestamp. Stopping scan.`);
                scanningStatus.delete(userId);
                return null;
            }

            for (let txIndex = 0; txIndex < block.transactions.length; txIndex++) {
                let tx = block.transactions[txIndex];
                txCount++;

                if (!tx.from || !tx.to || !tx.value) {
                    const txHash = block.transactions[txIndex];
                    tx = await retryAsync(async () => await provider.getTransaction(txHash));
                    if (!tx) {
                        logger.error(`Failed to fetch tx at index ${txIndex} in block ${block.number}`);
                        continue;
                    }
                }

                const txTimestamp = blockTimestamp;
                const isValid = (
                    tx.from.toLowerCase() === walletAddress.toLowerCase() &&
                    tx.to.toLowerCase() === TEAM_ADDRESS.toLowerCase() &&
                    tx.value.toString() === requiredAmount.toString() &&
                    txTimestamp >= verificationTimestamp
                );

                if (isValid) {
                    logger.info(`Found valid tx ${tx.hash} in block ${block.number}`);
                    const txHash = tx.hash;
                    scanningStatus.delete(userId);
                    return txHash;
                }
            }
            await delay(500);
            if (Date.now() - startTime > maxDuration) {
                logger.info('Transaction check aborted: exceeded time limit');
                scanningStatus.delete(userId);
                return null;
            }
        }
        logger.info(`Scanned ${txCount} transactions in blocks ${startBlock} to ${latestBlock}. No valid transaction found.`);
        scanningStatus.delete(userId);
        return null;
    } catch (error) {
        logger.error(`Error checking transaction for user ${userId}: ${error.message}`);
        scanningStatus.delete(userId);
        return null;
    }
}

// Check if Wallet Already Verified
function isWalletAlreadyVerified(walletAddress) {
    const verifiedGenesisUsers = loadVerifiedGenesisUsers();
    return Object.values(verifiedGenesisUsers).some(userData => userData.walletAddress.toLowerCase() === walletAddress.toLowerCase());
}

// Assign Roles Based on NFT Balance
async function assignRolesBasedOnBalance(member, nftBalance) {
    const guild = member.guild;
    let success = true;

    // Assign 1 Holder role if balance >= 1
    const oneRole = guild.roles.cache.get(ONE_HOLDER_ROLE);
    if (oneRole && nftBalance >= 1n) {
        await member.roles.add(oneRole);
        logger.info(`Assigned 1 Holder role to user ${member.id}`);
    } else if (oneRole && nftBalance < 1n) {
        // Safety: remove if balance dropped to 0
        if (member.roles.cache.has(oneRole.id)) {
            await member.roles.remove(oneRole);
        }
    } else {
        logger.error('1 Holder role not found');
        success = false;
    }

    // Determine and assign highest tier role only
    let tierRoleId = null;
    if (nftBalance >= 15n) {
        tierRoleId = FIFTEEN_HOLDER_ROLE;
    } else if (nftBalance >= 10n) {
        tierRoleId = TEN_HOLDER_ROLE;
    } else if (nftBalance >= 5n) {
        tierRoleId = FIVE_HOLDER_ROLE;
    } else if (nftBalance >= 2n) {
        tierRoleId = TWO_HOLDER_ROLE;
    }

    if (tierRoleId) {
        const tierRole = guild.roles.cache.get(tierRoleId);
        if (tierRole) {
            await member.roles.add(tierRole);
            logger.info(`Assigned tier role ${tierRoleId} to user ${member.id}`);
        } else {
            logger.error(`Tier role ${tierRoleId} not found`);
            success = false;
        }
    }

    return success;
}

// Remove All Tier Roles (including 1 Holder)
async function removeAllTierRoles(userId) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    try {
        const member = await guild.members.fetch(userId);
        const roleIds = [
            ONE_HOLDER_ROLE,
            TWO_HOLDER_ROLE,
            FIVE_HOLDER_ROLE,
            TEN_HOLDER_ROLE,
            FIFTEEN_HOLDER_ROLE
        ].filter(id => id); // Skip undefined/empty
        for (const roleId of roleIds) {
            const role = guild.roles.cache.get(roleId);
            if (role && member.roles.cache.has(role.id)) {
                await member.roles.remove(role);
                logger.info(`Removed role ${roleId} from user ${userId}`);
            }
        }
    } catch (err) {
        logger.error(`Error removing tier roles for ${userId}: ${err.message}`);
    }
}

// Start Verification
async function startVerification(interaction) {
    const userId = interaction.user.id;
    const lastVerified = completedVerifications.get(userId);

    if (lastVerified && (Date.now() - lastVerified) < TIME_LIMIT) {
        const timeLeft = new Date(lastVerified + TIME_LIMIT).toLocaleTimeString();

        const startNewButton = new ButtonBuilder()
            .setCustomId('start_new_verification')
            .setLabel('Start New')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(startNewButton);

        const embed = new EmbedBuilder()
            .setColor(COLOR_WARNING)
            .setTitle('⏳ Verification Active')
            .setDescription(`Your verification is still **active**. Wait until **${timeLeft}**.\n\nOr **start a new one** to override.`)
            .addFields(
                {
                    name: '⏰ Cooldown',
                    value: '10 minutes between verifications',
                    inline: true
                }
            )
            .setFooter({ text: 'OctoNads Verification • Secure & Fast' })
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            components: [row],
            flags: [MessageFlags.Ephemeral]
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId('verification_modal')
        .setTitle('🔍 Genesis NFT Verification');
    const walletInput = new TextInputBuilder()
        .setCustomId('wallet_address')
        .setLabel('Monad Wallet Address')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(42)
        .setPlaceholder('0x1234...abcd')
        .setMinLength(42);
    const actionRow = new ActionRowBuilder().addComponents(walletInput);
    modal.addComponents(actionRow);
    await interaction.showModal(modal);
}

// Bot Startup
client.once('ready', async () => {
    logger.info('Bot is online!');

    const channel = client.channels.cache.get(CHANNEL_ID);
    if (channel && channel.isTextBased()) {
        let oldMessageId;
        try {
            oldMessageId = fs.readFileSync(messageIdFile, 'utf8').trim();
        } catch (err) {
            logger.info('No previous message ID found.');
        }
        if (oldMessageId) {
            try {
                const oldMessage = await channel.messages.fetch(oldMessageId);
                if (oldMessage && oldMessage.deletable) {
                    await oldMessage.delete();
                    logger.info('Deleted previous verification button message.');
                }
            } catch (err) {
                logger.error(`Failed to fetch or delete previous button message: ${err.message}`);
            }
        }

        const verifyButton = new ButtonBuilder()
            .setCustomId('start_verification')
            .setLabel('Verify Genesis NFT')
            .setStyle(ButtonStyle.Primary);
        const checkStatusButton = new ButtonBuilder()
            .setCustomId('check_status')
            .setLabel('Status')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(verifyButton, checkStatusButton);

        const embed = new EmbedBuilder()
            .setColor(COLOR_PRIMARY)
            .setTitle('🌟 OctoNads Genesis NFT Verification')
            .setDescription('**Securely verify your OCTONADS GENESIS NFT** on Monad Mainnet for exclusive access to our Holders only community.')
            .addFields(
                {
                    name: '🚀 Quick Start Guide',
                    value: '1. **Click "Verify Genesis NFT"** below\n2. **Enter your wallet address**\n3. **Confirm your NFT & send 0.1 MON**\n4. **Receive your role instantly**',
                    inline: false
                },
                {
                    name: '⚠️ Key Notes',
                    value: '• **10-minute cooldown** per verification\n• **NFT transfers/sales** will reset roles automatically\n• **Having issues?** Head to #support channel\n• **No duplicate verifications** per wallet\n• Marketplace: [View Collection](' + MARKETPLACE_LINK + ')',
                    inline: false
                },
                {
                    name: '🎁 Exclusive Benefits',
                    value: '• **Tiered Holder Role(s)**: Unlock premium channels, Giveaways, and perks\n',
                    inline: false
                }
            )
            .setFooter({ text: 'Powered by OctoNads' })
            .setTimestamp();

        try {
            const newMessage = await channel.send({
                embeds: [embed],
                components: [row]
            });
            logger.info(`New verification button message sent with ID: ${newMessage.id}`);
            fs.writeFileSync(messageIdFile, newMessage.id);
        } catch (err) {
            logger.error(`Failed to send new verification message: ${err.message}`);
        }
    } else {
        logger.error('Channel not found or not text-based');
    }

    // Load Used Transaction Hashes
    usedTxHashes = loadUsedTxHashes();

    // Periodic Checks for Genesis
    const CHECK_INTERVAL = 10 * 60 * 1000; // 10 mins
    setInterval(async () => {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            logger.error('Guild not found for periodic check');
            return;
        }
        const verifiedGenesisUsers = loadVerifiedGenesisUsers();
        const usersToRemove = [];

        for (const [userId, userData] of Object.entries(verifiedGenesisUsers)) {
            const currentBalance = await checkGenesisNFTOwnership(userData.walletAddress);
            if (currentBalance === null) {
                logger.info(`Skipping Genesis user ${userId} due to persistent errors.`);
                continue;
            }
            if (currentBalance === 0n) {
                usersToRemove.push(userId);
                continue;
            }

            // Update roles for active holders
            const member = await guild.members.fetch(userId).catch(e => {
                logger.error(`Failed to fetch member ${userId} for role update: ${e.message}`);
                return null;
            });
            if (!member) continue;

            await removeAllTierRoles(userId);
            const assignSuccess = await assignRolesBasedOnBalance(member, currentBalance);
            if (!assignSuccess) {
                logger.warn(`Failed to assign updated roles for user ${userId} (balance: ${currentBalance})`);
            } else {
                logger.info(`Updated roles for user ${userId} based on current balance: ${currentBalance}`);
            }
        }

        if (usersToRemove.length > 0) {
            const currentVerifiedUsers = loadVerifiedGenesisUsers();
            for (const userId of usersToRemove) {
                await removeAllTierRoles(userId);
                const userData = currentVerifiedUsers[userId];
                logger.info(`Logged sale/transfer for user ${userId}, wallet ${userData.walletAddress}, tx ${userData.txHash}`);
                delete currentVerifiedUsers[userId];
            }
            saveVerifiedGenesisUsers(currentVerifiedUsers);
            logger.info(`Removed ${usersToRemove.length} Genesis users from verifiedGenesisUsers.json`);
        }
    }, CHECK_INTERVAL);
});

// Handle User Interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    logger.info(`Handling interaction: type=${interaction.type}, customId=${interaction.customId}`);

    try {
        if (interaction.isButton() && interaction.customId === 'start_verification') {
            await startVerification(interaction);
        }

        if (interaction.isButton() && interaction.customId === 'start_new_verification') {
            const userId = interaction.user.id;
            if (scanningStatus.has(userId)) {
                scanningStatus.get(userId).cancel = true;
                scanningStatus.delete(userId);
                logger.info(`Terminated previous scanning for user ${userId}`);
            }
            completedVerifications.delete(userId);

            const proceedButton = new ButtonBuilder()
                .setCustomId('proceed_to_verification')
                .setLabel('Proceed')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(proceedButton);

            const embed = new EmbedBuilder()
                .setColor(COLOR_WARNING)
                .setTitle('🛑 Scan Terminated')
                .setDescription('**Previous scan stopped successfully.** Ready to proceed to new verification.\n\nClick **Proceed** to start fresh.')
                .setFooter({ text: 'OctoNads Verification' })
                .setTimestamp();

            await interaction.reply({
                embeds: [embed],
                components: [row],
                flags: [MessageFlags.Ephemeral]
            });
        }

        if (interaction.isButton() && interaction.customId === 'proceed_to_verification') {
            const modal = new ModalBuilder()
                .setCustomId('verification_modal')
                .setTitle('🔍 Genesis NFT Verification');
            const walletInput = new TextInputBuilder()
                .setCustomId('wallet_address')
                .setLabel('Monad Wallet Address')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(42)
                .setPlaceholder('0x1234...abcd')
                .setMinLength(42);
            const actionRow = new ActionRowBuilder().addComponents(walletInput);
            modal.addComponents(actionRow);
            await interaction.showModal(modal);
        }

        if (interaction.isButton() && interaction.customId === 'try_again') {
            const embed = new EmbedBuilder()
                .setColor(COLOR_ERROR)
                .setTitle('⚠️ Error Occurred')
                .setDescription('**Something went wrong.** Please retry from the main panel.\n\nIf issues persist, contact support.')
                .setFooter({ text: 'OctoNads Support' });

            await interaction.reply({
                embeds: [embed],
                flags: [MessageFlags.Ephemeral]
            });
            return;
        }

        // Modal Submit
        if (interaction.isModalSubmit() && interaction.customId === 'verification_modal') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const walletAddress = interaction.fields.getTextInputValue('wallet_address').trim();

            if (!ethers.isAddress(walletAddress)) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_ERROR)
                    .setTitle('❌ Invalid Address')
                    .setDescription('**Invalid wallet format detected.** Please use a valid Monad address starting with `0x...`.')
                    .addFields(
                        {
                            name: '📝 Format Example',
                            value: '`0x1234567890abcdef...` (42 characters)',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Check your input and try again' })
                    .setTimestamp();

                await interaction.editReply({
                    embeds: [embed]
                });
                deleteMessageAfterTimeout(interaction);
                return;
            }

            // Check if already verified
            if (isWalletAlreadyVerified(walletAddress)) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_WARNING)
                    .setTitle('🔒 Already Verified')
                    .setDescription('**This wallet is already verified.** No duplicate verifications allowed.\n\nIf you think this is an error, contact support.')
                    .addFields(
                        {
                            name: 'ℹ️ Note',
                            value: 'Roles are tied to NFT ownership - they auto-update.',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Secure one-time verification' });

                await interaction.editReply({
                    embeds: [embed]
                });
                deleteMessageAfterTimeout(interaction);
                return;
            }

            const nftBalance = await checkGenesisNFTOwnership(walletAddress);

            if (nftBalance === 0n) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_ERROR)
                    .setTitle('❌ No Genesis NFT Found')
                    .setDescription('**No OCTONADS GENESIS NFT detected in your wallet.** Please ensure the correct address and try again.\n\n[View Collection on Marketplace](' + MARKETPLACE_LINK + ')')
                    .addFields(
                        {
                            name: '🔍 Double-Check',
                            value: '• Wallet address\n• NFT ownership on Monad Mainnet',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Need help? #support' });

                await interaction.editReply({
                    embeds: [embed]
                });
                deleteMessageAfterTimeout(interaction);
                return;
            }

            pendingVerifications.set(interaction.user.id, {
                walletAddress,
                timestamp: Date.now(),
                nftBalance
            });

            const confirmButton = new ButtonBuilder()
                .setCustomId('confirm_transaction')
                .setLabel('Auto-Scan Tx')
                .setStyle(ButtonStyle.Success);
            const txHashButton = new ButtonBuilder()
                .setCustomId('submit_tx_hash')
                .setLabel('Submit Hash')
                .setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(confirmButton, txHashButton);

            const embed = new EmbedBuilder()
                .setColor(COLOR_SUCCESS)
                .setTitle('🎉 Genesis NFT Verified!')
                .setDescription(`**✅ You hold **${nftBalance}** OCTONADS GENESIS NFT(s) in wallet: \`${walletAddress}\`**\n\n**Next: Complete the verification**\n• Send **exactly 0.1 MON** to: \`${TEAM_ADDRESS}\`\n• **10-minute window** to confirm\n\n**Pro Tip**: Use "Submit Hash" for instant verification. Auto-scan may take up to 10 mins.\n\n[View on Marketplace](' + MARKETPLACE_LINK + ')`)
                .addFields(
                    {
                        name: '💰 Transaction Details',
                        value: '`Amount: 0.1 MON`\n`To: ' + TEAM_ADDRESS + '`\n`Network: Monad Mainnet`',
                        inline: true
                    },
                    {
                        name: '⏱️ Time Left',
                        value: '10 minutes',
                        inline: true
                    }
                )
                .setFooter({ text: 'Secure verification powered by OctoNads' })
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed],
                components: [row]
            });

            setTimeout(async () => {
                try {
                    await interaction.deleteReply();
                    logger.info('Deleted transaction prompt after 10 minutes');
                } catch (err) {
                    logger.error(`Failed to delete transaction prompt: ${err.message}`);
                }
            }, 10 * 60 * 1000);
        }

        // Tx Hash Modal
        if (interaction.isButton() && interaction.customId === 'submit_tx_hash') {
            const modal = new ModalBuilder()
                .setCustomId('tx_hash_modal')
                .setTitle('📋 Submit Transaction Hash');
            const txInput = new TextInputBuilder()
                .setCustomId('tx_hash')
                .setLabel('Transaction Hash (0x...)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(66)
                .setPlaceholder('0xabcdef... (64 characters)')
                .setMinLength(66);
            const actionRow = new ActionRowBuilder().addComponents(txInput);
            modal.addComponents(actionRow);
            await interaction.showModal(modal);
        }

        // Tx Hash Submit
        if (interaction.isModalSubmit() && interaction.customId === 'tx_hash_modal') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const txHash = interaction.fields.getTextInputValue('tx_hash').trim();
            const verification = pendingVerifications.get(interaction.user.id);

            if (!verification || (Date.now() - verification.timestamp) > TIME_LIMIT) {
                pendingVerifications.delete(interaction.user.id);
                const embed = new EmbedBuilder()
                    .setColor(COLOR_ERROR)
                    .setTitle('⏰ Session Expired')
                    .setDescription('**Time window closed.** Please restart the verification process from the main panel.')
                    .addFields(
                        {
                            name: '🔄 Action',
                            value: 'Click "Verify Genesis NFT" to begin again.',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Sessions last 10 minutes' });

                await interaction.editReply({
                    embeds: [embed]
                });
                deleteMessageAfterTimeout(interaction);
                return;
            }

            if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_ERROR)
                    .setTitle('❌ Invalid Hash Format')
                    .setDescription('**Hash does not match the required format.** Ensure it starts with `0x` and is 66 characters long.')
                    .addFields(
                        {
                            name: '📋 Correct Format',
                            value: '`0x' + 'a-f0-9'.repeat(32) + '...`',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Copy-paste directly from explorer' });

                await interaction.editReply({
                    embeds: [embed]
                });
                deleteMessageAfterTimeout(interaction);
                return;
            }

            const transactionValid = await verifyTxHash(txHash, verification.walletAddress, verification.timestamp);
            if (transactionValid) {
                const currentBalance = await checkGenesisNFTOwnership(verification.walletAddress);

                if (currentBalance === null) {
                    const embed = new EmbedBuilder()
                        .setColor(COLOR_ERROR)
                        .setTitle('⚠️ Network Error')
                        .setDescription('**Unable to check current NFT balance due to RPC issues.** Please try again in a moment.')
                        .setFooter({ text: 'Contact support if this persists' });

                    await interaction.editReply({ embeds: [embed] });
                    deleteMessageAfterTimeout(interaction);
                    pendingVerifications.delete(interaction.user.id);
                    return;
                }

                if (currentBalance < verification.nftBalance) {
                    pendingVerifications.delete(interaction.user.id);

                    let description = '**Ownership changed since verification started.**\n\nPlease restart the process to verify your current holdings.';
                    if (currentBalance === 0n) {
                        description = '**You no longer hold any Genesis NFTs in this wallet.**\n\nVerification failed.';
                    }

                    const embed = new EmbedBuilder()
                        .setColor(COLOR_ERROR)
                        .setTitle('❌ Verification Failed')
                        .setDescription(description)
                        .addFields({
                            name: '🔄 Next Step',
                            value: 'Start a new verification from the main panel.',
                            inline: false
                        })
                        .setFooter({ text: 'Roles are tied to current ownership' });

                    await interaction.editReply({ embeds: [embed] });
                    deleteMessageAfterTimeout(interaction);
                    return;
                }

                // Remove all previous tier roles first, then assign based on current balance
                await removeAllTierRoles(interaction.user.id);
                const assignSuccess = await assignRolesBasedOnBalance(interaction.member, currentBalance);

                const verifiedGenesisUsers = loadVerifiedGenesisUsers();
                verifiedGenesisUsers[interaction.user.id] = {
                    walletAddress: verification.walletAddress,
                    txHash,
                    verifiedAt: Date.now(),
                    finalBalance: Number(currentBalance)
                };
                saveVerifiedGenesisUsers(verifiedGenesisUsers);

                if (assignSuccess) {
                    usedTxHashes.add(txHash);
                    saveUsedTxHashes();

                    let extraNote = '';
                    if (currentBalance > verification.nftBalance) {
                        extraNote = `\n\n**🎉 Bonus: You now hold ${currentBalance} NFT(s) — roles upgraded instantly!**`;
                    }

                    const embed = new EmbedBuilder()
                        .setColor(COLOR_SUCCESS)
                        .setTitle('🎉 Verification Complete!')
                        .setDescription(`**✅ Transaction validated & current ownership confirmed.**\n**✅ Holder role(s) granted/updated.**${extraNote}\n\n**Welcome to the OctoNads elite!** 🚀`)
                        .addFields(
                            {
                                name: '🏷️ Current Holding',
                                value: `**${currentBalance} Genesis NFT(s)**`,
                                inline: true
                            },
                            {
                                name: '⏰ Next Verification',
                                value: 'Available in 10 minutes',
                                inline: true
                            },
                            {
                                name: '🔗 Tx Details',
                                value: `\`${txHash}\``,
                                inline: true
                            }
                        )
                        .setFooter({ text: 'Enjoy exclusive perks! [Marketplace](' + MARKETPLACE_LINK + ')' })
                        .setTimestamp();

                    await interaction.editReply({
                        embeds: [embed]
                    });
                    deleteMessageAfterTimeout(interaction);
                    completedVerifications.set(interaction.user.id, Date.now());

                    const thankYouEmbed = new EmbedBuilder()
                        .setColor(COLOR_SUCCESS)
                        .setTitle('✨ Thanks for Verifying!')
                        .setDescription(`**You're all set!** Dive into the community and enjoy your Holder role(s).\n\nIf you have questions, #support is here to help.`)
                        .setFooter({ text: 'OctoNads Team' });

                    try {
                        await interaction.user.send({ embeds: [thankYouEmbed] });
                    } catch (err) {
                        logger.error(`Failed to send DM to ${interaction.user.id}: ${err.message}`);
                    }
                } else {
                    const embed = new EmbedBuilder()
                        .setColor(COLOR_ERROR)
                        .setTitle('❌ Role Assignment Error')
                        .setDescription('**Transaction valid, but issue assigning role(s).** Please reach out to an admin for manual assistance.')
                        .addFields(
                            {
                                name: '📞 Support',
                                value: 'Mention @Admin or visit #support',
                                inline: false
                            }
                        )
                        .setFooter({ text: 'We\'ll fix this quickly' });

                    await interaction.editReply({
                        embeds: [embed]
                    });
                    deleteMessageAfterTimeout(interaction);
                }
                pendingVerifications.delete(interaction.user.id);
            } else {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_ERROR)
                    .setTitle('❌ Transaction Invalid')
                    .setDescription('**Transaction does not match requirements.** Please double-check:')
                    .addFields(
                        {
                            name: '✅ Requirements',
                            value: '• **Exactly 0.1 MON**\n• **From your wallet**\n• **To: ' + TEAM_ADDRESS + '**\n• **Confirmed on Monad Mainnet**',
                            inline: false
                        },
                        {
                            name: '🔄 Next Step',
                            value: 'Send a new transaction and submit the hash.',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Use a block explorer to verify' });

                await interaction.editReply({
                    embeds: [embed]
                });
                deleteMessageAfterTimeout(interaction);
            }
        }

        // Confirm Transaction (Scan)
        if (interaction.isButton() && interaction.customId === 'confirm_transaction') {
            const verification = pendingVerifications.get(interaction.user.id);
            if (!verification || (Date.now() - verification.timestamp) > TIME_LIMIT) {
                pendingVerifications.delete(interaction.user.id);
                const embed = new EmbedBuilder()
                    .setColor(COLOR_ERROR)
                    .setTitle('⏰ Scan Timeout')
                    .setDescription('**Session expired.** Please start a new verification.')
                    .setFooter({ text: 'Restart from the panel' });

                await interaction.reply({
                    embeds: [embed],
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            if (scanningStatus.has(interaction.user.id)) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_WARNING)
                    .setTitle('🔄 Scan Already Running')
                    .setDescription('**Your auto-scan is active.** Use "View Progress" to monitor.')
                    .addFields(
                        {
                            name: '📈 Progress Check',
                            value: 'Updates every few seconds',
                            inline: true
                        }
                    )
                    .setFooter({ text: 'Be patient - blocks are being scanned' });

                await interaction.reply({
                    embeds: [embed],
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const checkStatusButton = new ButtonBuilder()
                .setCustomId('check_status')
                .setLabel('View Progress')
                .setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(checkStatusButton);

            const embed = new EmbedBuilder()
                .setColor(COLOR_INFO)
                .setTitle('🔍 Initiating Auto-Scan')
                .setDescription('**Scanning recent blocks for your transaction...**\nThis may take **up to 10 minutes** depending on network activity.\n\n**Stay tuned - results will arrive in DMs!**')
                .addFields(
                    {
                        name: '⚙️ Scan Details',
                        value: '• Looking for 0.1 MON to ' + TEAM_ADDRESS + '\n• From: ' + verification.walletAddress,
                        inline: false
                    },
                    {
                        name: '💡 Alternative',
                        value: 'Submit hash for instant check',
                        inline: true
                    }
                )
                .setFooter({ text: 'Powered by Monad RPC' })
                .setTimestamp();

            await interaction.reply({
                embeds: [embed],
                components: [row],
                flags: [MessageFlags.Ephemeral]
            });

            (async () => {
                try {
                    const txHash = await scanBlocksForTransaction(interaction.user.id, verification.walletAddress, verification.timestamp);

                    if (txHash) {
                        const currentBalance = await checkGenesisNFTOwnership(verification.walletAddress);

                        let successEmbed;
                        let assigned = false;

                        if (currentBalance === null) {
                            successEmbed = new EmbedBuilder()
                                .setColor(COLOR_ERROR)
                                .setTitle('⚠️ Verification Interrupted')
                                .setDescription('**Could not confirm current NFT balance due to network issues.**\nPlease try manual hash submission or restart.')
                                .setFooter({ text: 'Contact support if needed' });
                        } else if (currentBalance < verification.nftBalance) {
                            let msg = '**Ownership decreased since verification started.** Please restart to verify current holdings.';
                            if (currentBalance === 0n) {
                                msg = '**You no longer hold any Genesis NFTs.** Verification failed.';
                            }
                            successEmbed = new EmbedBuilder()
                                .setColor(COLOR_ERROR)
                                .setTitle('❌ Verification Failed')
                                .setDescription(msg)
                                .addFields({
                                    name: '🔄 Action',
                                    value: 'Start a new verification.',
                                    inline: false
                                });
                        } else {
                            // Remove all previous tier roles first, then assign based on current balance
                            await removeAllTierRoles(interaction.user.id);
                            assigned = await assignRolesBasedOnBalance(interaction.member, currentBalance);

                            const verifiedGenesisUsers = loadVerifiedGenesisUsers();
                            verifiedGenesisUsers[interaction.user.id] = {
                                walletAddress: verification.walletAddress,
                                txHash,
                                verifiedAt: Date.now(),
                                finalBalance: Number(currentBalance)
                            };
                            saveVerifiedGenesisUsers(verifiedGenesisUsers);

                            usedTxHashes.add(txHash);
                            saveUsedTxHashes();

                            let extraNote = '';
                            if (currentBalance > verification.nftBalance) {
                                extraNote = `\n\n**🎉 You acquired more NFTs — roles upgraded instantly!**`;
                            }

                            successEmbed = new EmbedBuilder()
                                .setColor(COLOR_SUCCESS)
                                .setTitle('🎉 Auto-Scan Complete - Verified!')
                                .setDescription(`**✅ Transaction found & current ownership confirmed.**${extraNote}\n**✅ Holder role(s) granted/updated.**`)
                                .addFields(
                                    {
                                        name: '🏷️ Current Holding',
                                        value: `**${currentBalance} Genesis NFT(s)**`,
                                        inline: true
                                    },
                                    {
                                        name: '🔗 Tx Hash',
                                        value: `\`${txHash}\``,
                                        inline: true
                                    }
                                )
                                .setFooter({ text: `Scan completed | [Marketplace](${MARKETPLACE_LINK})` })
                                .setTimestamp();
                        }

                        try {
                            await interaction.user.send({ embeds: [successEmbed] });
                        } catch (err) {
                            logger.error(`Failed to send scan result DM to ${interaction.user.id}: ${err.message}`);
                        }

                        if (assigned) {
                            completedVerifications.set(interaction.user.id, Date.now());
                        }
                    } else {
                        const noTxEmbed = new EmbedBuilder()
                            .setColor(COLOR_WARNING)
                            .setTitle('🔍 Scan Complete - No Match')
                            .setDescription('**No valid transaction detected in recent blocks.**\n\n**Possible reasons:**\n• Tx not yet confirmed\n• Wrong amount/address\n• Scan window missed')
                            .addFields(
                                {
                                    name: '🔄 Options',
                                    value: '• Submit hash manually\n• Wait & rescan\n• Check tx on explorer',
                                    inline: false
                                }
                            )
                            .setFooter({ text: 'Try submitting the hash for faster check' });

                        try {
                            await interaction.user.send({ embeds: [noTxEmbed] });
                        } catch (err) {
                            logger.error(`Failed to send scan failure DM to ${interaction.user.id}: ${err.message}`);
                        }
                    }
                    pendingVerifications.delete(interaction.user.id);
                } catch (err) {
                    logger.error(`Error in scan process for user ${interaction.user.id}: ${err.message}`);
                }
            })();
        }

        // Status Check
        if (interaction.isButton() && interaction.customId === 'check_status') {
            const status = scanningStatus.get(interaction.user.id);
            if (!status) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_WARNING)
                    .setTitle('📊 No Active Scan')
                    .setDescription('**No scan is currently running for you.**\n\nResults (success or failure) will be sent via DM once complete.')
                    .addFields(
                        {
                            name: 'ℹ️ Status',
                            value: 'Idle - Start a scan to begin',
                            inline: true
                        }
                    )
                    .setFooter({ text: 'Check DMs for updates' });

                await interaction.reply({
                    embeds: [embed],
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const { currentBlock, startBlock, latestBlock, startTime } = status;
            const blocksScanned = latestBlock - currentBlock;
            const totalBlocks = latestBlock - startBlock + 1;
            const percentage = ((blocksScanned / totalBlocks) * 100).toFixed(1);
            const timeElapsed = (Date.now() - startTime) / 1000;
            const estimatedTimePerBlock = blocksScanned > 0 ? timeElapsed / blocksScanned : 0;
            const blocksLeft = currentBlock - startBlock;
            const estimatedTimeLeft = (estimatedTimePerBlock * blocksLeft / 60).toFixed(1); // in minutes

            const progressBar = '█'.repeat(Math.floor(percentage / 10)) + '░'.repeat(10 - Math.floor(percentage / 10));
            const embed = new EmbedBuilder()
                .setColor(COLOR_INFO)
                .setTitle('📈 Scan Progress Dashboard')
                .setDescription(`**Scanning blocks for your 0.1 MON tx...**\n\n\`${progressBar}\` **${percentage}% Complete**`)
                .addFields(
                    {
                        name: '🎯 Current Block',
                        value: `${currentBlock} / ${startBlock} (Latest: ${latestBlock})`,
                        inline: true
                    },
                    {
                        name: '⏱️ ETA',
                        value: `${estimatedTimeLeft} minutes remaining`,
                        inline: true
                    },
                    {
                        name: '⏳ Time Elapsed',
                        value: `${(timeElapsed / 60).toFixed(1)} minutes`,
                        inline: true
                    }
                )
                .setFooter({ text: 'Real-time updates | Cancel anytime via new verification' })
                .setTimestamp();

            await interaction.reply({
                embeds: [embed],
                flags: [MessageFlags.Ephemeral]
            });
        }
    } catch (error) {
        logger.error(`Interaction error for customId=${interaction.customId}: ${error.message}`);
        const userId = interaction.user.id;
        pendingVerifications.delete(userId);
        scanningStatus.delete(userId);

        const tryAgainButton = new ButtonBuilder()
            .setCustomId('try_again')
            .setLabel('Retry from Panel')
            .setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(tryAgainButton);

        const embed = new EmbedBuilder()
            .setColor(COLOR_ERROR)
            .setTitle('💥 Unexpected Error')
            .setDescription('**An unforeseen issue occurred during verification.**\n\nDon\'t worry - this is rare!')
            .addFields(
                {
                    name: '🔄 Recommended Action',
                    value: 'Return to the main panel and try again.',
                    inline: false
                },
                {
                    name: '🆘 Support',
                    value: 'If it persists, ping @Admin in #support.',
                    inline: false
                }
            )
            .setFooter({ text: 'OctoNads Team is on it' })
            .setTimestamp();

        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
            } else if (interaction.deferred) {
                await interaction.editReply({ embeds: [embed], components: [row] });
            } else if (interaction.replied) {
                await interaction.followUp({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
            }
        } catch (replyError) {
            if (replyError.code === 10062) {
                logger.error('Interaction expired before reply could be sent');
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setColor(COLOR_ERROR)
                        .setTitle('💥 Verification Glitch')
                        .setDescription('**Head back to the panel and retry.** Support is available if needed.')
                        .setFooter({ text: 'OctoNads Support' });

                    await interaction.user.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    logger.error(`Failed to send DM: ${dmError.message}`);
                }
            } else {
                logger.error(`Failed to send error response: ${replyError.message}`);
            }
        }
    }
});

// Handle unhandled errors to prevent crashes
client.on('error', (error) => {
    logger.error(`Client error: ${error.message}`);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);