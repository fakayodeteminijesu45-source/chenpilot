import { Client, GatewayIntentBits, Message, TextChannel, Collection, Invite, GuildMember, Interaction, ChatInputCommandInteraction, ThreadChannel } from 'discord.js';
import { TransactionNotificationData, PriceAlert } from './types';
import { createTrustlineOperation } from '@chen-pilot/sdk-core';
import { normalizeCommand, SUPPORTED_CURRENCIES, SupportedCurrency } from '../commands';
import { PriceChartService } from '../priceChart';
import { withPerformanceProfiling } from '../performanceProfiler';
import { extractCommandName } from '../utils/commandUtils';
import { RateLimiter, DEFAULT_RATE_LIMIT, STRICT_RATE_LIMIT } from '../rateLimiter';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon.stellar.org';
const DEBOUNCE_MS = 2000;
const SENSITIVE_COMMANDS = ['!trustline', '!swap', '!multisig', '!validate'];
const SCAM_DETECTION_ENABLED = (process.env.SCAM_DETECTION_ENABLED ?? 'true') === 'true';
const SCAM_DETECTION_CHANNELS: string[] = (process.env.SCAM_DETECTION_CHANNELS ?? '').split(',').filter(Boolean);
const ADVANCED_ROLE_NAMES: string[] = (process.env.ADVANCED_ROLE_NAMES ?? 'admin,moderator').split(',').filter(Boolean);

type TrendingAsset = { assetCode: string; domain?: string; priceChange24h: number; volume24h: number; holders: number };
class AssetVerificationService { constructor(_: string) {} }
class ScamDetectionService {}
class AgentClient { constructor(_: { baseUrl: string }) {} }

export class DiscordAdapter {
  private client: Client;
  private userChannels: Map<string, string> = new Map(); // userId -> channelId
  private token: string;
  private invites: Map<string, Collection<string, Invite>> = new Map();
  private auditLogChannelId?: string;
  private lastCommandTime: Map<string, number> = new Map();
  private userCurrency: Map<string, SupportedCurrency> = new Map();
  private priceAlerts: Map<string, PriceAlert> = new Map();
  private verificationService: AssetVerificationService;
  private defaultRateLimiter: RateLimiter;
  private strictRateLimiter: RateLimiter;
  private scamDetectionService: ScamDetectionService;
  private marketOverviewService: any;
  private agentClient: any;
  private priceChartService: PriceChartService;

  constructor(token: string, auditLogChannelId?: string) {
    this.token = token;
    this.auditLogChannelId =
      auditLogChannelId || process.env.DISCORD_AUDIT_LOG_CHANNEL_ID;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
      ],
    });
    this.verificationService = new AssetVerificationService(HORIZON_URL);
    // #123: Initialize rate limiters
    this.defaultRateLimiter = new RateLimiter(DEFAULT_RATE_LIMIT);
    this.strictRateLimiter = new RateLimiter(STRICT_RATE_LIMIT);
    // #124: Initialize scam detection service
    this.scamDetectionService = new ScamDetectionService();
    // #128: Initialize market overview service
    this.marketOverviewService = new MarketOverviewService();
    // #881: Initialize price chart service for chart generation + text alternatives
    this.priceChartService = new PriceChartService();
    // #114: Initialize AI agent client
    this.agentClient = new AgentClient({ baseUrl: BACKEND_URL });
  }

  // #145: Returns true if the user is flooding (within debounce window)
  private isFlooding(userId: string): boolean {
    const now = Date.now();
    const last = this.lastCommandTime.get(userId) ?? 0;
    if (now - last < DEBOUNCE_MS) return true;
    this.lastCommandTime.set(userId, now);
    return false;
  }

  // #123: Check rate limit for a user and command
  private checkRateLimit(
    userId: string,
    command: string
  ): { allowed: boolean; message?: string } {
    // Determine which rate limiter to use based on command
    const isSensitive = SENSITIVE_COMMANDS.some((cmd) =>
      command.startsWith(cmd)
    );
    const rateLimiter = isSensitive
      ? this.strictRateLimiter
      : this.defaultRateLimiter;

    const status = rateLimiter.check(userId);

    if (!status.allowed) {
      const retryAfter = status.retryAfter || 60;
      return {
        allowed: false,
        message: `⏳ Rate limit exceeded. Please wait ${retryAfter} seconds before trying again.`,
      };
    }

    return { allowed: true };
  }

  // #124: Check if scam detection should be applied to a channel
  private shouldScanForScams(message: Message): boolean {
    if (!SCAM_DETECTION_ENABLED) return false;
    if (isDM(message)) return false; // Don't scan DMs

    // If specific channels are configured, only scan those
    if (SCAM_DETECTION_CHANNELS.length > 0) {
      return SCAM_DETECTION_CHANNELS.includes(message.channelId);
    }

    // Otherwise, scan all public channels
    return true;
  }

  // #124: Handle detected scam links
  private async handleScamDetection(
    message: Message,
    result: { isScam: boolean; reason?: string; matchedPattern?: string }
  ): Promise<void> {
    const warningMessage =
      `🚨 **Potential Scam Link Detected**\n\n` +
      `**Reason:** ${result.reason}\n` +
      `**Pattern:** \`${result.matchedPattern}\`\n\n` +
      `This message has been ${SCAM_DETECTION_ACTION === "block" ? "blocked" : "flagged"} for your safety.`;

    if (SCAM_DETECTION_ACTION === "block") {
      await message.delete();
      // Cast to TextChannel since we only scan public channels
      if (
        message.channel.type === ChannelType.GuildText ||
        message.channel.type === ChannelType.GuildPublicThread ||
        message.channel.type === ChannelType.GuildPrivateThread
      ) {
        await message.channel.send(warningMessage);
      }
    } else {
      await message.reply(warningMessage);
    }

    // Log to audit channel if configured
    await this.logAuditAction({
      action: "SCAM_LINK_DETECTED",
      triggeredBy: message.author.id,
      details: `Reason: ${result.reason}, Pattern: ${result.matchedPattern}, Action: ${SCAM_DETECTION_ACTION}`,
      success: true,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Create a DigestTarget for the MarketDigestScheduler.
   * Register the returned target with the scheduler in index.ts.
   *
   * The target posts to DISCORD_MARKET_OVERVIEW_CHANNEL_ID using Discord
   * markdown formatting and writes an audit log entry on success or failure.
   *
   * Returns null when no channel ID is configured so the caller can skip
   * registration gracefully.
   */
  createDigestTarget(): DigestTarget | null {
    if (!MARKET_OVERVIEW_CHANNEL_ID) {
      return null;
    }
    // Capture `this` for the closure
    const adapter = this;
    const channelId = MARKET_OVERVIEW_CHANNEL_ID;

    return {
      label: `discord:${channelId}`,
      async post(data) {
        const message = adapter.marketOverviewService.formatForDiscord(data);
        const channel = adapter.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel) {
          throw new Error(`Discord channel ${channelId} not found in cache`);
        }
        await channel.send(message);
        await adapter.logAuditAction({
          action: "MARKET_OVERVIEW_POSTED",
          triggeredBy: "system",
          details: `Channel: ${channelId}`,
          success: true,
          timestamp: new Date().toISOString(),
        });
      },
    };
  }

  // Register slash commands with Discord via REST API
  async deploySlashCommands(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN || this.token;
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!token || !clientId) {
      console.warn("⚠️ Discord: DISCORD_CLIENT_ID or token missing, skipping slash command deployment.");
      return;
    }
    const rest = new REST({ version: "10" }).setToken(token);
    try {
      console.log("🔄 Deploying slash commands...");
      await rest.put(Routes.applicationCommands(clientId), {
        body: slashCommandDefinitions,
      });
      console.log(`✅ Deployed ${slashCommandDefinitions.length} slash commands.`);
    } catch (error) {
      console.error("❌ Failed to deploy slash commands:", error);
    }
  }

  async init() {
    const token = process.env.DISCORD_BOT_TOKEN || this.token;
    if (!token) {
      console.warn("⚠️ Discord: No token provided, skipping initialization.");
      return;
    }

    this.client.once("ready", async () => {
      console.log(`✅ Discord bot logged in as ${this.client.user?.tag}`);
      await this.cacheInvites();
      console.log("📥 Discord: Initialized invite cache.");
    });

    this.client.on("inviteCreate", async (invite: Invite) => {
      const guildInvites = this.invites.get(invite.guild?.id || "");
      if (guildInvites) {
        guildInvites.set(invite.code, invite);
      }
    });

    this.client.on("inviteDelete", async (invite: Invite) => {
      const guildInvites = this.invites.get(invite.guild?.id || "");
      if (guildInvites) {
        guildInvites.delete(invite.code);
      }
    });

    this.client.on("guildMemberAdd", async (member: GuildMember) => {
      try {
        const cachedInvites = this.invites.get(member.guild.id);
        const newInvites = await member.guild.invites.fetch();
        
        // Find which invite's usage count increased
        const usedInvite = newInvites.find(inv => {
          const cached = cachedInvites?.get(inv.code);
          return cached ? (inv.uses || 0) > (cached.uses || 0) : (inv.uses || 0) > 0;
        });

        // Update cache
        this.invites.set(member.guild.id, newInvites);

        if (usedInvite) {
          const inviter = usedInvite.inviter;
          console.log(`👤 Referral: ${member.user.tag} joined via ${usedInvite.code} (Inviter: ${inviter?.tag || 'Unknown'})`);
          
          await this.logReferral(member.id, inviter?.id || 'unknown', usedInvite.code);
          
          // Optionally send a welcome message or log to a channel
          const systemChannel = member.guild.systemChannel;
          if (systemChannel) {
            await systemChannel.send(`Welcome ${member}! You were invited by ${inviter || 'an unknown hero'}.`);
          }
        } else {
          console.log(`👤 Member ${member.user.tag} joined (No invite matched)`);
        }
      } catch (error) {
        console.error("Error tracking referral:", error);
      }
    });

    this.client.on("messageCreate", async (message: Message) => {
      if (message.author.bot) return;

      const content = message.content;

      if (content === "!start") {
        await message.reply(
          "Welcome to Chen Pilot! I am your AI-powered Stellar DeFi assistant."
        );
        return;
      }

      if (content === "!sponsor") {
        const userId = message.author.id;
        await message.reply("⏳ Requesting account sponsorship...");

        try {
          await this.sendWelcomeMessage(member);
        } catch (error) {
          console.error("❌ Error sending welcome message:", error);
        }
      });
    });

    // Handle button interactions
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isButton()) return;

      const buttonId = interaction.customId;
      const handler = this.buttonHandlers.get(buttonId);

      const genericInteraction: GenericButtonInteraction = {
        platform: 'discord',
        userId: interaction.user.id,
        buttonId: buttonId,
        chatId: interaction.channelId || '',
        raw: interaction,
        reply: async (message: string) => {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp(message);
          } else {
            await interaction.reply(message);
          }
        } catch (error) {
          console.error("Sponsor command error:", error);
          await message.reply(
            "❌ Could not reach the sponsorship service. Please try again later."
          );
        }
        return;
      }

      if (content.startsWith('!trustline')) {
        const text = content.split(' ').slice(1).join(' ');
        if (!text) {
          return message.reply('Usage: !trustline <assetCode> [issuerDomain|issuerAddress] OR !trustline <description>\nExample: !trustline USDC circle.com OR !trustline the dollar stablecoin');
        }

        const args = text.split(' ');
        let assetCode = args[0];
        let assetIssuer = args[1];

      if (handler) {
        try {
          // If we only have one arg or it doesn't look like a code + issuer, try AI recognition
          if (!assetIssuer || assetCode.length > 12) {
            await message.reply(`🔍 AI is identifying the asset: "${text}"...`);
            const recognized = await this.recognizeAsset(text, message.author.id);
            
            if (recognized) {
              assetCode = recognized.assetCode;
              assetIssuer = recognized.issuer;
              await message.reply(`💡 AI recognized this as **${assetCode}**${assetIssuer ? ` from \`${assetIssuer}\`` : ''}.\n${recognized.description}`);
            } else if (!assetIssuer) {
              return message.reply(`❌ Could not recognize asset from "${text}". Please provide an asset code and issuer address/domain.`);
            }
          }

          if (!assetIssuer && assetCode !== 'XLM') {
            return message.reply(`Please provide an issuer domain or address for ${assetCode}.`);
          }

          await message.reply(`🔍 Looking up asset ${assetCode}${assetIssuer ? ` from ${assetIssuer}` : ''}...`);
          const op = await createTrustlineOperation(assetCode, assetIssuer || 'native');
          
          let response = `✅ Found asset ${assetCode}!\n\n`;
          response += `To add this trustline, you can use the following details in your wallet:\n`;
          response += `**Asset:** ${assetCode}\n`;
          response += `**Issuer:** \`${(op as any).asset.issuer || 'native'}\`\n\n`;
          response += `*Note: In a future update, I will provide a direct signing link.*`;
          
          await message.reply(response);
        } catch (error) {
          console.error('Error handling button interaction:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply('❌ An error occurred while processing your button click.');
          }
        }
      } else {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply('⚠️ No handler found for this button.');
        }
        return;
      }

      // Handle natural language asset recognition
      if (!content.startsWith('!')) {
        const keywords = ['add', 'trustline', 'asset', 'coin', 'stablecoin', 'token'];
        const lowercaseText = content.toLowerCase();
        
        if (keywords.some(k => lowercaseText.includes(k))) {
          try {
            const recognized = await this.recognizeAsset(content, message.author.id);
            if (recognized && recognized.confidence > 0.8) {
              let response = `🤖 It sounds like you're talking about **${recognized.assetCode}**!\n\n`;
              response += `${recognized.description}\n\n`;
              response += `Would you like to add a trustline for this asset? Use \`!trustline ${recognized.assetCode} ${recognized.issuer || ''}\``;
              
              await message.reply(response);
            }
          } catch (error) {
            console.error("Passive AI recognition error:", error);
          }
        }
      }
    this.client.on(
      "messageCreate",
      withPerformanceProfiling(
        "messageCreate",
        "discord",
        "system",
        async (message: Message) => {
          if (message.author.bot) return;

          // #124: Scan for scam links in public channels
          if (this.shouldScanForScams(message)) {
            const scamResult = this.scamDetectionService.detectScamLinks(
              message.content
            );
            if (scamResult.isScam) {
              await this.handleScamDetection(message, scamResult);
              return; // Stop processing if scam is detected and blocked
            }
    // Slash command interaction handler
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction);
    });

    this.client.on("messageCreate", withPerformanceProfiling(
      'messageCreate',
      'discord',
      'system',
      async (message: Message) => {
        if (message.author.bot) return;

        // Legacy ! prefix commands are deprecated. Please use slash commands (/) instead.
        const isLegacyCommand = message.content.startsWith('!');
        if (isLegacyCommand) {
          await message.reply('⚠️ **Deprecation Notice:** `!` prefix commands are deprecated. Please use `/` slash commands instead (e.g. `/help`, `/ping`).');
          return;
        }

        // #124: Scan for scam links in public channels
        if (this.shouldScanForScams(message)) {
          const scamResult = this.scamDetectionService.detectScamLinks(message.content);
          if (scamResult.isScam) {
            await this.handleScamDetection(message, scamResult);
            return; // Stop processing if scam is detected and blocked
          }

          const userId = message.author.id;
          const command = message.content.split(" ")[0];
          const commandName = extractCommandName(message.content, "discord");

          // #145: Anti-flood check for all commands
          if (this.isFlooding(userId)) {
            await message.reply(
              "⏳ Please wait a moment before sending another command."
            );
            return;
          }

          // #123: Rate limit check
          const rateLimitResult = this.checkRateLimit(userId, command);
          if (!rateLimitResult.allowed) {
            await message.reply(
              rateLimitResult.message ??
                "⏳ Rate limit exceeded. Please try again later."
            );
            return;
          }

          // Wrap each command handler with performance profiling
          if (message.content === "!start") {
            await withPerformanceProfiling(
              "!start",
              "discord",
              userId,
              async () => {
                await message.reply(
                  "Welcome to Chen Pilot! I am your AI-powered Stellar DeFi assistant. Type !help to see what I can do!"
                );
              }
            )();
          }

          // #134: Ping command — measure end-to-end latency
          if (message.content === "!ping") {
            await withPerformanceProfiling(
              "!ping",
              "discord",
              userId,
              async () => {
                const startTime = Date.now();
                try {
                  const controller = new AbortController();
                  const timeout = setTimeout(() => controller.abort(), 5000);
                  const response = await fetch(`${BACKEND_URL}/api/health`, {
                    method: "GET",
                    signal: controller.signal,
                  });
                  clearTimeout(timeout);
                  const roundtripMs = Date.now() - startTime;
                  if (response.ok) {
                    await message.reply(
                      `🏓 **Pong!**\n\n📡 **End-to-End Latency:** ${roundtripMs}ms\n✅ Backend: Online`
                    );
                  } else {
                    await message.reply(
                      `🏓 **Pong!**\n\n📡 **End-to-End Latency:** ${roundtripMs}ms\n⚠️ Backend: Returned HTTP ${response.status}`
                    );
                  }
                } catch {
                  const roundtripMs = Date.now() - startTime;
                  await message.reply(
                    `🏓 **Pong!**\n\n📡 **End-to-End Latency:** ${roundtripMs}ms\n❌ Backend: Unreachable`
                  );
                }
              }
            )();
          }

          if (message.content.startsWith("!help")) {
            await withPerformanceProfiling(
              commandName,
              "discord",
              userId,
              async () => {
                const query = message.content.replace("!help", "").trim();
                const results = searchFeatures(query);
                const isSearch = query.length > 0;
                await message.reply(
                  formatHelpMessage(results, isSearch, "markdown")
                );
              }
            )();
          }

          if (message.content === "!thread") {
            await withPerformanceProfiling(
              "!thread",
              "discord",
              userId,
              async () => {
                if (message.channel.type === ChannelType.GuildText) {
                  try {
                    const thread = await message.startThread({
                      name: `Chen Pilot Session - ${message.author.username}`,
                      autoArchiveDuration: 60,
                    });
                    await thread.send(
                      `👋 Hello ${message.author.username}! I've started this thread to keep our conversation organized. How can I help you with Stellar DeFi today?`
                    );
                  } catch (error) {
                    console.error("Error creating thread:", error);
                    await message.reply(
                      "❌ I couldn't start a thread. Please make sure I have the 'Create Public Threads' permission."
                    );
                  }
                } else if (message.channel.isThread()) {
                  await message.reply(
                    "🧵 We are already in a thread! I'm ready to assist you here."
                  );
                } else {
                  await message.reply(
                    "❌ Threads can only be started in text channels."
                  );
                }
              }
            )();
          }
        if (message.content.startsWith("!help")) {
      await withPerformanceProfiling(commandName, 'discord', userId, async () => {
        const query = message.content.replace("!help", "").trim();
        
        if (query.length > 0) {
          // Check if it's a natural language question vs keyword search
          const isNaturalLanguage = query.includes(" ") && !["swap", "balance", "trustline", "sponsor", "notify", "status", "price", "help"].includes(query.toLowerCase());
          
          if (isNaturalLanguage) {
            try {
              await message.reply("🤖 Thinking... Let me get you some help with that.");
              const response = await this.agentClient.query({
                userId,
                query,
              });
              // Assume AgentResponse has a message field, or use result directly
              const aiResponse = typeof response.result === 'string' ? response.result : (response.result as any).message || "Sorry, I couldn't help with that.";
              await message.reply(formatAiHelpMessage(aiResponse, "markdown"));
            } catch (error) {
              // Fallback to keyword search if AI fails
              console.error("AI help failed, falling back to keyword search:", error);
              const results = searchFeatures(query);
              await message.reply(formatHelpMessage(results, true, "markdown"));
            }
          } else {
            // Keyword search
            const results = searchFeatures(query);
            await message.reply(formatHelpMessage(results, true, "markdown"));
          }
        } else {
          // Show all commands
          const results = searchFeatures(query);
          await message.reply(formatHelpMessage(results, false, "markdown"));
        }
      })();
    }

          if (message.content === "!sponsor") {
            await withPerformanceProfiling(
              "!sponsor",
              "discord",
              userId,
              async () => {
                await message.reply("⏳ Requesting account sponsorship...");

                try {
                  const response = await fetch(
                    `${BACKEND_URL}/api/account/${userId}/sponsor`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                    }
                  );
                  const data = (await response.json()) as {
                    success: boolean;
                    message: string;
                    address?: string;
                  };

                  if (data.success) {
                    await message.reply(
                      `✅ Account sponsored successfully!\n📬 Address: \`${data.address}\``
                    );
                    await this.logAuditAction({
                      action: "SPONSOR_ACCOUNT",
                      triggeredBy: userId,
                      details: `Address: ${data.address}`,
                      success: true,
                      timestamp: new Date().toISOString(),
                    });
                  } else {
                    await message.reply(
                      `❌ Sponsorship failed: ${data.message}`
                    );
                    await this.logAuditAction({
                      action: "SPONSOR_ACCOUNT",
                      triggeredBy: userId,
                      details: `Failed: ${data.message}`,
                      success: false,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch (error) {
                  console.error("Sponsor command error:", error);
                  await message.reply(
                    "❌ Could not reach the sponsorship service. Please try again later."
                  );
                }
              }
            )();
          }

          if (message.content.startsWith("!trustline")) {
            await withPerformanceProfiling(
              commandName,
              "discord",
              userId,
              async () => {
                const args = message.content.split(" ").slice(1);
                if (args.length < 1) {
                  return message.reply(
                    "Usage: !trustline <assetCode> [issuerDomain|issuerAddress]\nExample: !trustline USDC circle.com"
                  );
                }

                const assetCode = args[0];
                const assetIssuer = args[1];

                if (!assetIssuer) {
                  return message.reply(
                    `Please provide an issuer domain or address for ${assetCode}.`
                  );
                }

                try {
                  await message.reply(
                    `🔍 Looking up asset ${assetCode} from ${assetIssuer}...`
                  );
                  const op = await createTrustlineOperation(
                    assetCode,
                    assetIssuer
                  );

                  let response = `✅ Found asset ${assetCode}!\n\n`;
                  response += `To add this trustline, you can use the following details in your wallet:\n`;
                  response += `**Asset:** ${assetCode}\n`;
                  response += `**Issuer:** \`${(op as { asset: { issuer: string } }).asset.issuer}\`\n\n`;
                  response += `*Note: In a future update, I will provide a direct signing link.*`;

                  await message.reply(response);
                  await this.logAuditAction({
                    action: "TRUSTLINE_LOOKUP",
                    triggeredBy: message.author.id,
                    details: `Asset: ${assetCode}, Issuer: ${assetIssuer}`,
                    success: true,
                    timestamp: new Date().toISOString(),
                  });
                } catch (error) {
                  await message.reply(
                    `❌ Error: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              }
            )();
          }

          // #146: Dashboard command
          if (message.content === "!dashboard") {
            await withPerformanceProfiling(
              "!dashboard",
              "discord",
              userId,
              async () => {
                await message.reply(
                  `📊 **Chen Pilot Dashboard**\n\nAccess your admin dashboard here:\n🔗 ${DASHBOARD_URL}\n\n*Note: You must be logged in to view the dashboard.*`
                );
              }
            )();
          }

          // #148: /validate command for Stellar asset verification
          if (message.content.startsWith("!validate")) {
            await withPerformanceProfiling(
              commandName,
              "discord",
              userId,
              async () => {
                const args = message.content.split(" ").slice(1);
                if (args.length < 2) {
                  return message.reply(
                    "Usage: !validate <assetCode> <issuerAddress>\nExample: !validate USDC GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
                  );
                }

                const [assetCode, issuerAddress] = args;
                await message.reply(
                  `🔍 Verifying asset **${assetCode}** from issuer \`${issuerAddress.slice(0, 8)}...\``
                );

                try {
                  const result = await this.verificationService.verifyAsset(
                    assetCode,
                    issuerAddress
                  );
                  const statusEmoji =
                    result.status === "VERIFIED"
                      ? "✅"
                      : result.status === "MALICIOUS"
                        ? "🚨"
                        : "⚠️";

                  let reply = `${statusEmoji} **Asset Verification: ${result.status}**\n\n`;
                  reply += `**Asset:** ${assetCode}\n`;
                  reply += `**Issuer:** \`${issuerAddress}\`\n`;
                  if (result.domain) reply += `**Domain:** ${result.domain}\n`;
                  if (result.details)
                    reply += `**Details:** ${result.details}\n`;
                  reply += `\n**Safe to use:** ${result.isSafe ? "Yes ✅" : "No ❌"}`;

                  await message.reply(reply);
                } catch (error) {
                  await message.reply(
                    `❌ Verification error: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              }
            )();
          }

          // #125: Multisig wizard command
          if (message.content === "!multisig") {
            if (!isDM(message)) {
              await rejectPublicChannel(message);
              return;
            }

            const response = await botWorkflowManager.startWorkflow(
              userId,
              "discord",
              "multisig_wizard"
            );
            await message.reply(response.message);
            return;
          }

          // Swap wizard command
          if (message.content === "!swap") {
            if (!isDM(message)) {
              await rejectPublicChannel(message);
              return;
            }

            const response = await botWorkflowManager.startWorkflow(
              userId,
              "discord",
              "swap_wizard"
            );
            await message.reply(response.message);
            return;
          }

          // Handle wizard input (for active wizard sessions)
          const response = await botWorkflowManager.handleInput(
            userId,
            "discord",
            message.content
          );
          if (response) {
            await message.reply(response.message);
            return;
          }

          // #118: !currency command — set preferred report currency
          if (message.content.startsWith("!currency")) {
            const arg = message.content.split(" ")[1]?.toUpperCase();
            if (
              !arg ||
              !SUPPORTED_CURRENCIES.includes(
                arg as (typeof SUPPORTED_CURRENCIES)[number]
              )
            ) {
              return message.reply(
                `Usage: !currency <USD|XLM|BTC>\nCurrent: **${this.userCurrency.get(userId) ?? "USD"}**`
              );
            }
            this.userCurrency.set(
              userId,
              arg as (typeof SUPPORTED_CURRENCIES)[number]
            );
            return message.reply(`✅ Report currency set to **${arg}**`);
          }

          // #118: !report command — portfolio report in preferred currency
          if (message.content.startsWith("!report")) {
            const currency = this.userCurrency.get(userId) ?? "USD";
            await message.reply(
              `⏳ Fetching portfolio report in **${currency}**...`
            );
            try {
              const res = await fetch(
                `${BACKEND_URL}/api/portfolio/${userId}?currency=${currency}`
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = (await res.json()) as {
                totalValue: number;
                assets: { code: string; balance: number; value: number }[];
              };
              let reply = `📊 **Portfolio Report (${currency})**\n\n`;
              reply += `**Total Value:** ${data.totalValue.toFixed(4)} ${currency}\n\n`;
              for (const a of data.assets) {
                reply += `• **${a.code}**: ${a.balance} ≈ ${a.value.toFixed(4)} ${currency}\n`;
              }
              return message.reply(reply);
            } catch {
              return message.reply(
                `❌ Could not fetch portfolio. Make sure your account is registered.`
              );
            }
          }
              const op = await createTrustlineOperation(assetCode, assetIssuer);

              let response = `✅ Found asset ${assetCode}!\n\n`;
              response += `To add this trustline, you can use the following details in your wallet:\n`;
              response += `**Asset:** ${assetCode}\n`;
              response += `**Issuer:** \`${(op as { asset: { issuer: string } }).asset.issuer}\`\n\n`;
              response += `*Note: In a future update, I will provide a direct signing link.*`;

              await message.reply(response);
              await this.logAuditAction({
                action: 'TRUSTLINE_LOOKUP',
                triggeredBy: message.author.id,
                details: `Asset: ${assetCode}, Issuer: ${assetIssuer}`,
                success: true,
                timestamp: new Date().toISOString(),
              });
            } catch (error) {
              await message.reply(
                `❌ Error: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          })();
        }

        // #109: Swap command
        if (message.content.startsWith('!swap')) {
          await withPerformanceProfiling('!swap', 'discord', userId, async () => {
            if (!isDM(message)) {
              await rejectPublicChannel(message);
              return;
            }

        if (message.content === '!buttons') {
          await withPerformanceProfiling('!buttons', 'discord', userId, async () => {
            // Example buttons
            const buttons: Button[] = [
              { label: 'Primary', id: 'primary-btn', style: 'primary' },
              { label: 'Success', id: 'success-btn', style: 'success' },
              { label: 'Open Dashboard', id: 'dashboard-btn', url: DASHBOARD_URL }
            ];

            // Register example handlers
            this.registerButtonHandler('primary-btn', async (interaction) => {
              await interaction.reply('Primary button pressed!');
            });
            this.registerButtonHandler('success-btn', async (interaction) => {
              await interaction.reply('Success button pressed!');
            });

            await this.sendWithButtons(message.channelId, 'Try pressing these buttons!', buttons);
          })();
        }

        // #148: /validate command for Stellar asset verification
        if (message.content.startsWith('!validate')) {
          await withPerformanceProfiling(commandName, 'discord', userId, async () => {
            const args = message.content.split(' ').slice(1);
            if (args.length < 3) {
              return message.reply('Usage: !swap <fromAsset> <toAsset> <amount>\nExample: !swap XLM USDC 100');
            }

            const [fromAsset, toAsset, amountStr] = args;
            const amount = parseFloat(amountStr);

            if (isNaN(amount) || amount <= 0) {
              return message.reply('❌ Amount must be a positive number.');
            }

            try {
              await message.reply('🔄 Initiating swap...');
              const response = await this.agentClient.query({
                userId,
                query: `swap ${amount} ${fromAsset} to ${toAsset}`
              });

              const result = response.result;
              if (typeof result === 'string') {
                await message.reply(result);
              } else if ((result as any).successful) {
                let reply = '✅ **Swap Successful!**\n\n';
                reply += `**From:** ${(result as any).from} ${(result as any).amount}\n`;
                reply += `**To:** ${(result as any).to}\n`;
                reply += `**Estimated Output:** ${(result as any).estimatedOutput}\n`;
                reply += `**Tx Hash:** \`${(result as any).txHash}\``;
                await message.reply(reply);
              } else {
                await message.reply(`❌ Swap failed: ${(result as any).message || 'Unknown error'}`);
              }
            } catch (error) {
              console.error('Swap command error:', error);
              await message.reply('❌ Could not complete the swap. Please try again later.');
            }
          })();
        }

        // #146: Dashboard command
        if (message.content === '!dashboard') {
          await withPerformanceProfiling('!dashboard', 'discord', userId, async () => {
            await message.reply(
              `📊 **Chen Pilot Dashboard**\n\nAccess your admin dashboard here:\n🔗 ${DASHBOARD_URL}\n\n*Note: You must be logged in to view the dashboard.*`
            );
          })();
        }

          // #119: !alert command — set a price alert
          if (message.content.startsWith("!alert")) {
            const args = message.content.split(" ").slice(1);
            if (args.length < 3) {
              return message.reply(
                "Usage: !alert <assetCode> <above|below> <price> [USD|XLM|BTC]\nExample: !alert XLM above 0.15 USD"
              );
            }
            const [assetCode, conditionRaw, priceRaw, currencyRaw] = args;
            const condition = conditionRaw.toLowerCase() as "above" | "below";
            if (condition !== "above" && condition !== "below") {
              return message.reply("❌ Condition must be `above` or `below`.");
            }
            const targetPrice = parseFloat(priceRaw);
            if (isNaN(targetPrice) || targetPrice <= 0) {
              return message.reply("❌ Price must be a positive number.");
            }
            const currency =
              currencyRaw?.toUpperCase() ??
              this.userCurrency.get(userId) ??
              "USD";
            if (
              !SUPPORTED_CURRENCIES.includes(
                currency as (typeof SUPPORTED_CURRENCIES)[number]
              )
            ) {
              return message.reply(
                `❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`
              );
            }
            const alertId = `${userId}-${assetCode}-${Date.now()}`;
            const alert: PriceAlert = {
              id: alertId,
              userId,
              assetCode: assetCode.toUpperCase(),
              targetPrice,
              currency: currency as (typeof SUPPORTED_CURRENCIES)[number],
              condition,
              createdAt: new Date().toISOString(),
              triggered: false,
            };
            this.priceAlerts.set(alertId, alert);
            // Register channel for DM delivery
            if (!this.userChannels.has(userId))
              this.userChannels.set(userId, message.channelId);
            return message.reply(
              `🔔 Alert set: notify me when **${assetCode.toUpperCase()}** is ${condition} **${targetPrice} ${currency}**`
            );
          }

          // #119: !alerts — list active alerts
          if (message.content === "!alerts") {
            const userAlerts = [...this.priceAlerts.values()].filter(
              (a) => a.userId === userId && !a.triggered
            );
            if (userAlerts.length === 0)
              return message.reply(
                "📭 You have no active price alerts. Use `!alert` to set one."
              );
            let reply = `🔔 **Your Active Alerts**\n\n`;
            for (const a of userAlerts) {
              reply += `• **${a.assetCode}** ${a.condition} ${a.targetPrice} ${a.currency} (ID: \`${a.id.slice(-6)}\`)\n`;
            }
            return message.reply(reply);
          const response = this.multisigWizard.startWizard(userId, 'discord');
          await message.reply(response.message);
        }

        // Handle wizard input (for active wizard sessions)
        const wizardState = this.multisigWizard.getWizardState(userId, 'discord');
        if (wizardState && !WIZARD_COMMANDS.includes(message.content.split(' ')[0])) {
          const response = this.multisigWizard.processInput(userId, 'discord', message.content);
          await message.reply(response.message);
        }

      // #118: !currency command — set preferred report currency
      if (message.content.startsWith('!currency')) {
        const arg = message.content.split(' ')[1]?.toUpperCase() as 'USD' | 'XLM' | 'BTC' | undefined;
        if (!arg || !(SUPPORTED_CURRENCIES as readonly string[]).includes(arg)) {
          return message.reply(`Usage: !currency <USD|XLM|BTC>\nCurrent: **${this.userCurrency.get(userId) ?? 'USD'}**`);
        }

        // #118: !report command — portfolio report in preferred currency
        if (message.content.startsWith('!report')) {
          const currency = this.userCurrency.get(userId) ?? 'USD';
          await message.reply(`⏳ Fetching portfolio report in **${currency}**...`);
          try {
            const res = await fetch(`${BACKEND_URL}/api/portfolio/${userId}?currency=${currency}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { totalValue: number; assets: { code: string; balance: number; value: number }[] };
            let reply = `📊 **Portfolio Report (${currency})**\n\n`;
            reply += `**Total Value:** ${data.totalValue.toFixed(4)} ${currency}\n\n`;
            for (const a of data.assets) {
              reply += `• **${a.code}**: ${a.balance} ≈ ${a.value.toFixed(4)} ${currency}\n`;
            }
            return message.reply(reply);
          } catch {
            return message.reply(`❌ Could not fetch portfolio. Make sure your account is registered.`);
          }

          // #120: !advanced — role-gated command example
          if (message.content.startsWith("!advanced")) {
            if (!this.hasAdvancedRole(message)) {
              return message.reply(
                `🔒 This command requires one of the following roles: **${ADVANCED_ROLE_NAMES.join(", ")}**`
              );
            }
            return message.reply(
              "✅ Advanced command executed. (Role check passed)"
            );
          }
      // #119: !alert command — set a price alert
      if (message.content.startsWith('!alert')) {
        const args = message.content.split(' ').slice(1);
        if (args.length < 3) {
          return message.reply('Usage: !alert <assetCode> <above|below> <price> [USD|XLM|BTC]\nExample: !alert XLM above 0.15 USD');
        }
        const [assetCode, conditionRaw, priceRaw, currencyRaw] = args;
        const condition = conditionRaw.toLowerCase() as 'above' | 'below';
        if (condition !== 'above' && condition !== 'below') {
          return message.reply('❌ Condition must be `above` or `below`.');
        }
        const targetPrice = parseFloat(priceRaw);
        if (isNaN(targetPrice) || targetPrice <= 0) {
          return message.reply('❌ Price must be a positive number.');
        }
        const currency = (currencyRaw?.toUpperCase() ?? this.userCurrency.get(userId) ?? 'USD') as 'USD' | 'XLM' | 'BTC';
        if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
          return message.reply(`❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);
        }

        // #119: !alert command — set a price alert
        if (message.content.startsWith('!alert')) {
          const args = message.content.split(' ').slice(1);
          if (args.length < 3) {
            return message.reply('Usage: !alert <assetCode> <above|below> <price> [USD|XLM|BTC]\nExample: !alert XLM above 0.15 USD');
          }
          const [assetCode, conditionRaw, priceRaw, currencyRaw] = args;
          const condition = conditionRaw.toLowerCase() as 'above' | 'below';
          if (condition !== 'above' && condition !== 'below') {
            return message.reply('❌ Condition must be `above` or `below`.');
          }
          const targetPrice = parseFloat(priceRaw);
          if (isNaN(targetPrice) || targetPrice <= 0) {
            return message.reply('❌ Price must be a positive number.');
          }
          const currency = (currencyRaw?.toUpperCase() ?? this.userCurrency.get(userId) ?? 'USD') as 'USD' | 'XLM' | 'BTC';
          if (!SUPPORTED_CURRENCIES.includes(currency as any)) {
            return message.reply(`❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);
          }
          const alertId = `${userId}-${assetCode}-${Date.now()}`;
          const alert: PriceAlert = { id: alertId, userId, assetCode: assetCode.toUpperCase(), targetPrice, currency, condition, createdAt: new Date().toISOString(), triggered: false };
          this.priceAlerts.set(alertId, alert);
          // Register channel for DM delivery
          if (!this.userChannels.has(userId)) this.userChannels.set(userId, message.channelId);
          return message.reply(`🔔 Alert set: notify me when **${assetCode.toUpperCase()}** is ${condition} **${targetPrice} ${currency}**`);
        }

        // #119: !alerts — list active alerts
        if (message.content === '!alerts') {
          const userAlerts = [...this.priceAlerts.values()].filter(a => a.userId === userId && !a.triggered);
          if (userAlerts.length === 0) return message.reply('📭 You have no active price alerts. Use `!alert` to set one.');
          let reply = `🔔 **Your Active Alerts**\n\n`;
          for (const a of userAlerts) {
            reply += `• **${a.assetCode}** ${a.condition} ${a.targetPrice} ${a.currency} (ID: \`${a.id.slice(-6)}\`)\n`;
          }
          return message.reply(reply);
        }

          // #121: !discover — suggest trending Stellar assets
          if (message.content === "!discover") {
            if (!this.hasAdvancedRole(message)) {
              return message.reply(
                `🔒 \`!discover\` requires one of the following roles: **${ADVANCED_ROLE_NAMES.join(", ")}**`
              );
            }
            await message.reply("🔍 Discovering trending Stellar assets...");
            try {
              const res = await fetch(`${BACKEND_URL}/api/assets/trending`);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const assets = (await res.json()) as TrendingAsset[];
              if (!assets.length)
                return message.reply(
                  "📭 No trending assets found at this time."
                );
              let reply = `🌟 **Trending Stellar Assets**\n\n`;
              for (const a of assets.slice(0, 5)) {
                const change =
                  a.priceChange24h >= 0
                    ? `+${a.priceChange24h.toFixed(2)}%`
                    : `${a.priceChange24h.toFixed(2)}%`;
                const emoji = a.priceChange24h >= 0 ? "📈" : "📉";
                reply += `${emoji} **${a.assetCode}**${a.domain ? ` (${a.domain})` : ""}\n`;
                reply += `  24h Change: ${change} | Volume: ${a.volume24h.toLocaleString()} | Holders: ${a.holders.toLocaleString()}\n\n`;
              }
              return message.reply(reply);
            } catch {
              return message.reply(
                "❌ Could not fetch trending assets. Please try again later."
              );
            }
          }
        }
      )
    );
      }

      // Price chart command - generate static price chart for an asset
      if (message.content.startsWith('!price')) {
        await withPerformanceProfiling(commandName, 'discord', userId, async () => {
          const args = message.content.split(' ').slice(1);
          if (args.length < 1) {
            return message.reply('Usage: !price <assetCode> [currency] [days]\nExample: !price XLM USD 7\n\nSupported currencies: USD, XLM, BTC\nDefault: USD, 7 days');
          }

          const assetCode = args[0].toUpperCase();
          const currency = (args[1]?.toUpperCase() ?? this.userCurrency.get(userId) ?? 'USD') as 'USD' | 'XLM' | 'BTC';
          const days = parseInt(args[2] ?? '7', 10);

          if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
            return message.reply(`❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);
          }

          if (isNaN(days) || days < 1 || days > 90) {
            return message.reply('❌ Days must be between 1 and 90');
          }

          await message.reply(`📊 Generating price chart for **${assetCode}** (${days} days)...`);

          try {
            // Fetch historical data once — used for both chart image and text alternative
            const priceData = await this.priceChartService.fetchHistoricalPriceData(
              assetCode,
              currency,
              days
            );

            // Generate the chart image
            const chartBuffer = await this.priceChartService.generateChart(
              assetCode,
              priceData
            );

            // Generate comprehensive text alternative (accessible summary of chart data)
            const textSummary = this.priceChartService.generateTextSummary(
              assetCode,
              priceData,
              { currency, days, platform: 'discord' }
            );

            // Send the text summary + chart attachment (text supplements the image, stands alone for accessibility)
            await message.reply({
              content: textSummary,
              files: [{
                attachment: chartBuffer,
                name: `${assetCode}_price_chart.png`
              }]
            });

          } catch (error) {
            console.error('Price chart generation error:', error);
            await message.reply(`❌ Could not generate price chart for **${assetCode}**. The asset may not be supported or the API is unavailable.`);
          }
        })();
      }
    }));

    await this.client.login(token);
    await this.deploySlashCommands();
    this.startAlertPolling();
    console.log("✅ Discord bot initialized.");
  }

  /**
   * Calls the backend AI asset recognition service
   */
  private async recognizeAsset(query: string, userId: string): Promise<any> {
    try {
      const response = await fetch(`${BACKEND_URL}/api/assets/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, query })
      });

      const data = await response.json() as any;
      if (data.success) {
        return data.asset;
      }
      return null;
    } catch (error) {
      console.error("Error calling asset recognition API:", error);
      return null;
    }
  }

  /**
   * Register a user to receive notifications
   */
  async registerUser(userId: string, channelId: string): Promise<boolean> {
    this.userChannels.set(userId, channelId);
    return true;
  }

  async sendTransactionNotification(
    userId: string,
    data: TransactionNotificationData
  ): Promise<boolean> {
    if (!this.client || !this.client.user) {
      console.warn("⚠️ Discord bot not initialized");
      return false;
    }

    const channelId = this.userChannels.get(userId);
    if (!channelId) {
      console.warn(`⚠️ No channel ID found for user ${userId}`);
      return false;
    }

    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      console.warn(
        `⚠️ Channel or Thread ${channelId} not found or not text-based`
      );
    const channel = this.client.channels.cache.get(
      channelId
    ) as TextChannel;
    if (!channel) {
      console.warn(`⚠️ Channel or Thread ${channelId} not found`);
      return false;
    }

    const message = this.formatTransactionMessage(data);

    try {
      await (channel as TextChannel).send(message);
      await channel.send(message);
      // Additionally log to a dedicated transaction thread if configured
      if (TRANSACTION_THREAD_LOGGING_ENABLED && TRANSACTION_LOG_CHANNEL_ID) {
        try {
          const thread = await this.getOrCreateTransactionThread(userId, data.from);
          if (thread) {
            const detailed = this.formatDetailedTransactionLog(data);
            await thread.send(detailed);
          }
        } catch (e) {
          console.error('Error logging transaction to thread:', e);
        }
      }
      await this.logAuditAction({
        action: "SEND_TRANSACTION_NOTIFICATION",
        triggeredBy: userId,
        details: `Hash: ${data.hash.slice(0, 8)}...${data.hash.slice(-8)}, Success: ${data.successful}`,
        success: true,
        timestamp: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      console.error("Error sending Discord notification:", error);
      return false;
    }
  }

  private async getOrCreateTransactionThread(userId: string, username?: string): Promise<ThreadChannel | null> {
    if (!TRANSACTION_THREAD_LOGGING_ENABLED || !TRANSACTION_LOG_CHANNEL_ID) return null;
    try {
      const ch = this.client.channels.cache.get(TRANSACTION_LOG_CHANNEL_ID) as TextChannel | undefined;
      if (!ch) return null;

      const existingThreadId = this.transactionThreads.get(userId);
      if (existingThreadId) {
        const existing = this.client.channels.cache.get(existingThreadId) as ThreadChannel | undefined;
        if (existing) return existing;
        this.transactionThreads.delete(userId);
      }

      // Fetch active threads in the channel and look for one matching the user
      const fetched = await ch.threads.fetch();
      const threadName = `tx-log-${userId}`;
      const found = fetched.threads.find(t => t.name === threadName);
      if (found) {
        this.transactionThreads.set(userId, found.id);
        return found as ThreadChannel;
      }

      // Create a starter message then start a thread from it
      const starter = await ch.send(`🔐 Starting transaction log thread for <@${userId}> (${username ?? userId})`);
      const thread = await starter.startThread({ name: threadName, autoArchiveDuration: TRANSACTION_THREAD_ARCHIVE_MINUTES });
      this.transactionThreads.set(userId, thread.id);
      return thread;
    } catch (e) {
      console.error('getOrCreateTransactionThread error', e);
      return null;
    }
  }

  private formatDetailedTransactionLog(data: TransactionNotificationData): string {
    const timestamp = new Date(data.timestamp).toISOString();
    let msg = `**Detailed Transaction Log` + `**\n`;
    msg += `• Hash: \`${data.hash}\`\n`;
    msg += `• Successful: ${data.successful}\n`;
    msg += `• From: \`${data.from}\`\n`;
    msg += `• To: \`${data.to}\`\n`;
    msg += `• Amount: ${data.amount} ${data.asset}\n`;
    if (data.fee) msg += `• Fee: ${data.fee} XLM\n`;
    if (data.memo) msg += `• Memo: ${data.memo}\n`;
    msg += `• Timestamp: ${timestamp}\n`;
    if ((data as any).raw) {
      msg += `\nRaw Payload:\n` + '```json\n' + JSON.stringify((data as any).raw, null, 2) + '\n```';
    }
    return msg;
  }

  private formatTransactionMessage(data: TransactionNotificationData): string {
    const statusEmoji = data.successful ? "✅" : "❌";
    const timestamp = new Date(data.timestamp).toLocaleString();

    let message = `**Transaction ${data.successful ? "Confirmed" : "Failed"}** ${statusEmoji}\n\n`;
    message += `📋 **Hash:** \`${data.hash.slice(0, 8)}...${data.hash.slice(-8)}\`\n`;
    message += `💰 **Amount:** ${data.amount} ${data.asset}\n`;
    message += `📤 **From:** \`${data.from.slice(0, 4)}...${data.from.slice(-4)}\`\n`;
    message += `📥 **To:** \`${data.to.slice(0, 4)}...${data.to.slice(-4)}\`\n`;
    message += `⏱️ **Time:** ${timestamp}\n`;

    if (data.fee) {
      message += `💵 **Fee:** ${data.fee} XLM\n`;
    }

    if (data.memo) {
      message += `📝 **Memo:** ${data.memo}\n`;
    }

    return message;
  }

  async sendNotification(userId: string, message: string): Promise<boolean> {
    if (!this.client || !this.client.user) {
      console.warn("⚠️ Discord bot not initialized");
      return false;
    }

    const channelId = this.userChannels.get(userId);
    if (!channelId) {
      return false;
    }

    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
    const channel = this.client.channels.cache.get(
      channelId
    ) as TextChannel;
    if (!channel) {
      return false;
    }

    try {
      await (channel as TextChannel).send(message);
      return true;
    } catch (error) {
      console.error("Error sending Discord notification:", error);
      return false;
    }
  }

  getClient(): Client {
    return this.client;
  }

  /**
   * Initial cache of all invites for all guilds the bot is in
   */
  private async cacheInvites() {
    if (!this.client.isReady()) return;
    
    for (const guild of this.client.guilds.cache.values()) {
      try {
        const guildInvites = await guild.invites.fetch();
        this.invites.set(guild.id, guildInvites);
      } catch (error) {
        console.error(`⚠️ Discord: Failed to fetch invites for guild ${guild.id}:`, error);
      }
    }
  }

  /**
   * Log referral data to the backend for future rewards
   */
  private async logReferral(newMemberId: string, inviterId: string, inviteCode: string) {
    try {
      console.log(`📡 Sending referral data to backend: ${newMemberId} invited by ${inviterId}`);
      
      const response = await fetch(`${BACKEND_URL}/api/referrals/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newMemberId,
          inviterId,
          inviteCode,
          platform: 'discord',
          timestamp: new Date().toISOString()
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`⚠️ Backend referral log failed: ${response.status} ${errorText}`);
      } else {
        console.log(`✅ Referral logged successfully for ${newMemberId}`);
      }
    } catch (error) {
      console.error("❌ Error logging referral to backend:", error);
    }
  }

  /**
   * Route chat-input (/) slash commands to their handlers.
   * Mirrors the behavior of the legacy `!` prefix commands where applicable.
   * Referenced by the `interactionCreate` handler at startup.
   */
  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const userId = interaction.user.id;
    const commandName = interaction.commandName;

    // Defer reply so longer-running commands (price chart, AI help) don't hit the 3s timeout
    await interaction.deferReply();

    try {
      switch (commandName) {
        case 'start': {
          await interaction.editReply(
            'Welcome to Chen Pilot! I am your AI-powered Stellar DeFi assistant.'
          );
          return;
        }

        case 'ping': {
          const startTime = Date.now();
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`${BACKEND_URL}/api/health`, {
              method: 'GET',
              signal: controller.signal,
            });
            clearTimeout(timeout);
            const roundtripMs = Date.now() - startTime;
            const backendStatus = response.ok
              ? 'Online'
              : `Returned HTTP ${response.status}`;
            await interaction.editReply(
              `🏓 **Pong!**\n\n📡 **End-to-End Latency:** ${roundtripMs}ms\n✅ Backend: ${backendStatus}`
            );
          } catch {
            const roundtripMs = Date.now() - startTime;
            await interaction.editReply(
              `🏓 **Pong!**\n\n📡 **End-to-End Latency:** ${roundtripMs}ms\n❌ Backend: Unreachable`
            );
          }
          return;
        }

        case 'help': {
          const query = interaction.options.getString('query') ?? '';
          const results = searchFeatures(query);
          const isSearch = query.length > 0;
          await interaction.editReply(
            formatHelpMessage(results, isSearch, 'markdown')
          );
          return;
        }

        case 'thread': {
          const channel = interaction.channel;
          if (channel && channel.type === ChannelType.GuildText) {
            try {
              const thread = await channel.threads.create({
                name: `Chen Pilot Session - ${interaction.user.username}`,
                autoArchiveDuration: 60,
                startMessage: undefined,
              });
              await interaction.editReply(
                `👋 Hello ${interaction.user.username}! I've started a dedicated thread to keep our conversation organized.`
              );
              await thread.send(
                `👋 Hello ${interaction.user.username}! How can I help you with Stellar DeFi today?`
              );
            } catch (error) {
              console.error('Error creating thread via slash command:', error);
              await interaction.editReply(
                "❌ I couldn't start a thread. Please make sure I have the 'Create Public Threads' permission."
              );
            }
          } else if (channel?.isThread?.()) {
            await interaction.editReply(
              "🧵 We are already in a thread! I'm ready to assist you here."
            );
          } else {
            await interaction.editReply(
              '❌ Threads can only be started in text channels.'
            );
          }
          return;
        }

        case 'sponsor': {
          await interaction.editReply('⏳ Requesting account sponsorship...');
          try {
            const response = await fetch(
              `${BACKEND_URL}/api/account/${userId}/sponsor`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              }
            );
            const data = (await response.json()) as {
              success: boolean;
              message: string;
              address?: string;
            };

            if (data.success) {
              await interaction.editReply(
                `✅ Account sponsored successfully!\n📬 Address: \`${data.address}\``
              );
              await this.logAuditAction({
                action: 'SPONSOR_ACCOUNT',
                triggeredBy: userId,
                details: `Address: ${data.address}`,
                success: true,
                timestamp: new Date().toISOString(),
              });
            } else {
              await interaction.editReply(
                `❌ Sponsorship failed: ${data.message}`
              );
            }
          } catch {
            await interaction.editReply(
              '❌ Could not reach the sponsorship service. Please try again later.'
            );
          }
          return;
        }

        case 'trustline': {
          const assetCode = interaction.options.getString('asset', true).toUpperCase();
          const assetIssuer = interaction.options.getString('issuer', true);

          await interaction.editReply(
            `🔍 Looking up asset **${assetCode}** from **${assetIssuer}**...`
          );

          try {
            const op = await createTrustlineOperation(assetCode, assetIssuer);
            const reply =
              `✅ Found asset **${assetCode}**!\n\n` +
              `To add this trustline, use the following details in your wallet:\n` +
              `**Asset:** ${assetCode}\n` +
              `**Issuer:** \`${(op as { asset: { issuer: string } }).asset.issuer}\``;
            await interaction.editReply(reply);
            await this.logAuditAction({
              action: 'TRUSTLINE_LOOKUP',
              triggeredBy: userId,
              details: `Asset: ${assetCode}, Issuer: ${assetIssuer}`,
              success: true,
              timestamp: new Date().toISOString(),
            });
          } catch (error) {
            await interaction.editReply(
              `❌ Error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          return;
        }

        case 'dashboard': {
          await interaction.editReply(
            `📊 **Chen Pilot Dashboard**\n\nAccess your admin dashboard here:\n🔗 ${DASHBOARD_URL}\n\n*Note: You must be logged in to view the dashboard.*`
          );
          return;
        }

        case 'validate': {
          const assetCode = interaction.options.getString('asset', true).toUpperCase();
          const issuerAddress = interaction.options.getString('issuer', true);

          await interaction.editReply(
            `🔍 Verifying asset **${assetCode}** from issuer \`${issuerAddress.slice(0, 8)}...\``
          );

          try {
            const result = await this.verificationService.verifyAsset(
              assetCode,
              issuerAddress
            );
            const statusEmoji =
              result.status === 'VERIFIED'
                ? '✅'
                : result.status === 'MALICIOUS'
                  ? '🚨'
                  : '⚠️';

            let reply = `${statusEmoji} **Asset Verification: ${result.status}**\n\n`;
            reply += `**Asset:** ${assetCode}\n`;
            reply += `**Issuer:** \`${issuerAddress}\`\n`;
            if (result.domain) reply += `**Domain:** ${result.domain}\n`;
            if (result.details) reply += `**Details:** ${result.details}\n`;
            reply += `\n**Safe to use:** ${result.isSafe ? 'Yes ✅' : 'No ❌'}`;

            await interaction.editReply(reply);
          } catch (error) {
            await interaction.editReply(
              `❌ Verification error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          return;
        }

        case 'multisig': {
          if (!isDM(interaction.channel ?? undefined)) {
            await interaction.editReply(
              '🔒 This command must be used in a Direct Message for security. Please DM me instead.'
            );
            return;
          }
          const response = await botWorkflowManager.startWorkflow(
            userId,
            'discord',
            'multisig_wizard'
          );
          await interaction.editReply(response.message);
          return;
        }

        case 'currency': {
          const arg = interaction.options.getString('currency', true).toUpperCase();
          if (
            !(SUPPORTED_CURRENCIES as readonly string[]).includes(arg)
          ) {
            await interaction.editReply(
              `❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}\nCurrent: **${this.userCurrency.get(userId) ?? 'USD'}**`
            );
            return;
          }
          this.userCurrency.set(
            userId,
            arg as (typeof SUPPORTED_CURRENCIES)[number]
          );
          await interaction.editReply(`✅ Report currency set to **${arg}**`);
          return;
        }

        case 'report': {
          const currency = this.userCurrency.get(userId) ?? 'USD';
          await interaction.editReply(
            `⏳ Fetching portfolio report in **${currency}**...`
          );
          try {
            const res = await fetch(
              `${BACKEND_URL}/api/portfolio/${userId}?currency=${currency}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
              totalValue: number;
              assets: { code: string; balance: number; value: number }[];
            };
            let reply = `📊 **Portfolio Report (${currency})**\n\n`;
            reply += `**Total Value:** ${data.totalValue.toFixed(4)} ${currency}\n\n`;
            for (const a of data.assets) {
              reply += `• **${a.code}**: ${a.balance} ≈ ${a.value.toFixed(4)} ${currency}\n`;
            }
            await interaction.editReply(reply);
          } catch {
            await interaction.editReply(
              '❌ Could not fetch portfolio. Make sure your account is registered.'
            );
          }
          return;
        }

        case 'alert': {
          const assetCode = interaction.options.getString('asset', true).toUpperCase();
          const condition = interaction.options.getString('condition', true) as 'above' | 'below';
          const targetPrice = interaction.options.getNumber('price', true);
          const currencyOpt = interaction.options.getString('currency');
          const currency =
            (currencyOpt?.toUpperCase() as 'USD' | 'XLM' | 'BTC' | undefined) ??
            this.userCurrency.get(userId) ??
            'USD';

          if (condition !== 'above' && condition !== 'below') {
            await interaction.editReply('❌ Condition must be `above` or `below`.');
            return;
          }
          if (targetPrice <= 0) {
            await interaction.editReply('❌ Price must be a positive number.');
            return;
          }
          if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
            await interaction.editReply(
              `❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`
            );
            return;
          }

          const alertId = `${userId}-${assetCode}-${Date.now()}`;
          const alert: PriceAlert = {
            id: alertId,
            userId,
            assetCode,
            targetPrice,
            currency,
            condition,
            createdAt: new Date().toISOString(),
            triggered: false,
          };
          this.priceAlerts.set(alertId, alert);
          const channelId = (interaction.channel as { id?: string })?.id;
          if (channelId && !this.userChannels.has(userId)) {
            this.userChannels.set(userId, channelId);
          }
          await interaction.editReply(
            `🔔 Alert set: notify me when **${assetCode}** is ${condition} **${targetPrice} ${currency}**`
          );
          return;
        }

        case 'alerts': {
          const userAlerts = [...this.priceAlerts.values()].filter(
            (a) => a.userId === userId && !a.triggered
          );
          if (userAlerts.length === 0) {
            await interaction.editReply(
              '📭 You have no active price alerts. Use `/alert` to set one.'
            );
            return;
          }
          let reply = `🔔 **Your Active Alerts**\n\n`;
          for (const a of userAlerts) {
            reply += `• **${a.assetCode}** ${a.condition} ${a.targetPrice} ${a.currency} (ID: \`${a.id.slice(-6)}\`)\n`;
          }
          await interaction.editReply(reply);
          return;
        }

        case 'advanced': {
          if (!this.hasAdvancedRole({ member: interaction.member as any, guild: interaction.guild as any })) {
            await interaction.editReply(
              `🔒 This command requires one of the following roles: **${ADVANCED_ROLE_NAMES.join(', ')}**`
            );
            return;
          }
          await interaction.editReply(
            '✅ Advanced command executed. (Role check passed)'
          );
          return;
        }

        case 'discover': {
          if (!this.hasAdvancedRole({ member: interaction.member as any, guild: interaction.guild as any })) {
            await interaction.editReply(
              `🔒 \`/discover\` requires one of the following roles: **${ADVANCED_ROLE_NAMES.join(', ')}**`
            );
            return;
          }
          await interaction.editReply('🔍 Discovering trending Stellar assets...');
          try {
            const res = await fetch(`${BACKEND_URL}/api/assets/trending`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const assets = (await res.json()) as TrendingAsset[];
            if (!assets.length) {
              await interaction.editReply('📭 No trending assets found at this time.');
              return;
            }
            let reply = `🌟 **Trending Stellar Assets**\n\n`;
            for (const a of assets.slice(0, 5)) {
              const change =
                a.priceChange24h >= 0
                  ? `+${a.priceChange24h.toFixed(2)}%`
                  : `${a.priceChange24h.toFixed(2)}%`;
              const emoji = a.priceChange24h >= 0 ? '📈' : '📉';
              reply += `${emoji} **${a.assetCode}**${a.domain ? ` (${a.domain})` : ''}\n`;
              reply += `  24h Change: ${change} | Volume: ${a.volume24h.toLocaleString()} | Holders: ${a.holders.toLocaleString()}\n\n`;
            }
            await interaction.editReply(reply);
          } catch {
            await interaction.editReply(
              '❌ Could not fetch trending assets. Please try again later.'
            );
          }
          return;
        }

        case 'price': {
          // #881: /price slash command — chart + accessible text alternative
          const assetCode = interaction.options.getString('asset', true).toUpperCase();
          const currencyOpt = interaction.options.getString('currency');
          const daysOpt = interaction.options.getInteger('days');
          const currency =
            (currencyOpt?.toUpperCase() as 'USD' | 'XLM' | 'BTC' | undefined) ??
            this.userCurrency.get(userId) ??
            'USD';
          const days = daysOpt ?? 7;

          if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
            await interaction.editReply(
              `❌ Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`
            );
            return;
          }
          if (days < 1 || days > 90) {
            await interaction.editReply('❌ Days must be between 1 and 90');
            return;
          }

          await interaction.editReply(
            `📊 Generating price summary for **${assetCode}** (${days} days)...`
          );

          try {
            // Fetch data once, reuse for image + text alternative
            const priceData = await this.priceChartService.fetchHistoricalPriceData(
              assetCode,
              currency,
              days
            );
            const chartBuffer = await this.priceChartService.generateChart(
              assetCode,
              priceData
            );
            const textSummary = this.priceChartService.generateTextSummary(
              assetCode,
              priceData,
              { currency, days, platform: 'discord' }
            );

            // Use followUp with files since editReply files support is limited on some Discord API versions
            await interaction.editReply(textSummary);
            if (interaction.channel?.isTextBased()) {
              await interaction.followUp({
                content: `📈 Chart for **${assetCode}**:`,
                files: [
                  {
                    attachment: chartBuffer,
                    name: `${assetCode}_price_chart.png`,
                  },
                ],
              });
            }
          } catch (error) {
            console.error('Price slash command error:', error);
            await interaction.editReply(
              `❌ Could not generate price chart for **${assetCode}**. The asset may not be supported or the API is unavailable.`
            );
          }
          return;
        }

        default: {
          await interaction.editReply(
            `⚠️ Command \`/${commandName}\` is not yet implemented.`
          );
          return;
        }
      }
    } catch (handlerError) {
      console.error(`Unhandled error in /${commandName} slash command:`, handlerError);
      try {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply('❌ An error occurred while processing your command.');
        }
      } catch {
        // swallow secondary reply error
      }
    }
  }
}
