import {
  SlashCommandBuilder,
  SlashCommandStringOption,
  SlashCommandNumberOption,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export const slashCommandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  [
    new SlashCommandBuilder()
      .setName("start")
      .setDescription("Welcome message and bot introduction")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Check bot latency and backend health")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("help")
      .setDescription("List available features or search for a specific one")
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("query")
          .setDescription("Search term to filter features")
          .setRequired(false)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("thread")
      .setDescription("Start a dedicated support thread in this channel")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("sponsor")
      .setDescription(
        "Request free Stellar account sponsorship (DM only for security)"
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("trustline")
      .setDescription("Look up a Stellar asset trustline")
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("asset")
          .setDescription("Asset code, e.g. USDC")
          .setRequired(true)
      )
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("issuer")
          .setDescription("Issuer domain or address, e.g. circle.com")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("dashboard")
      .setDescription("Get a link to the Chen Pilot admin dashboard")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("validate")
      .setDescription("Verify a Stellar asset for safety")
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("asset")
          .setDescription("Asset code, e.g. USDC")
          .setRequired(true)
      )
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("issuer")
          .setDescription("Issuer address (Stellar public key)")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("multisig")
      .setDescription("Start the multi-signature wallet setup wizard (DM only)")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("currency")
      .setDescription("Set your preferred reporting currency")
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("currency")
          .setDescription("Currency to use for reports")
          .setRequired(true)
          .addChoices(
            { name: "USD", value: "USD" },
            { name: "XLM", value: "XLM" },
            { name: "BTC", value: "BTC" }
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("report")
      .setDescription("Get your portfolio report in your preferred currency")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("alert")
      .setDescription("Set a price alert for a Stellar asset")
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("asset")
          .setDescription("Asset code, e.g. XLM")
          .setRequired(true)
      )
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("condition")
          .setDescription("Trigger condition")
          .setRequired(true)
          .addChoices(
            { name: "above", value: "above" },
            { name: "below", value: "below" }
          )
      )
      .addNumberOption((opt: SlashCommandNumberOption) =>
        opt
          .setName("price")
          .setDescription("Target price")
          .setRequired(true)
          .setMinValue(0)
      )
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("currency")
          .setDescription("Currency for the price (defaults to your set currency)")
          .setRequired(false)
          .addChoices(
            { name: "USD", value: "USD" },
            { name: "XLM", value: "XLM" },
            { name: "BTC", value: "BTC" }
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("alerts")
      .setDescription("List your active price alerts")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("advanced")
      .setDescription("Execute an advanced role-gated command")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("discover")
      .setDescription("Discover trending Stellar assets (requires advanced role)")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("price")
      .setDescription("View price chart and historical data for an asset")
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("asset")
          .setDescription("Asset code, e.g. XLM, USDC")
          .setRequired(true)
      )
      .addStringOption((opt: SlashCommandStringOption) =>
        opt
          .setName("currency")
          .setDescription("Quote currency (defaults to your preferred currency)")
          .setRequired(false)
          .addChoices(
            { name: "USD", value: "USD" },
            { name: "XLM", value: "XLM" },
            { name: "BTC", value: "BTC" }
          )
      )
      .addIntegerOption((opt: SlashCommandNumberOption) =>
        opt
          .setName("days")
          .setDescription("Number of days of historical data (1-90, default 7)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(90)
      )
      .toJSON(),
  ];
