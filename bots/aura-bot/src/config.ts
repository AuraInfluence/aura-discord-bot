function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  discordToken: requireEnv("DISCORD_BOT_TOKEN"),
  openaiBaseUrl: requireEnv("AI_INTEGRATIONS_OPENAI_BASE_URL"),
  openaiApiKey: requireEnv("AI_INTEGRATIONS_OPENAI_API_KEY"),
  guildId: env("DISCORD_GUILD_ID"),
  channels: {
    // 📋 Allgemein
    regelwerk: env("CHANNEL_REGELWERK"),
    "neu-dazugekommen": env("CHANNEL_NEU_DAZUGEKOMMEN"),
    "richtlinien-faq": env("CHANNEL_RICHTLINIEN_FAQ"),
    "agentur-faq": env("CHANNEL_AGENTUR_FAQ"),

    // 🌸 Informationen
    updates: env("CHANNEL_UPDATES"),
    information: env("CHANNEL_INFORMATION"),
    umfragen: env("CHANNEL_UMFRAGEN"),
    "tipps-und-tricks": env("CHANNEL_TIPPS_UND_TRICKS"),
    "live-manager": env("CHANNEL_LIVE_MANAGER"),
    "agentur-info": env("CHANNEL_AGENTUR_INFO"),

    // 🏆 Belohnungssystem
    monatsrangliste: env("CHANNEL_MONATSRANGLISTE"),
    wochenrangliste: env("CHANNEL_WOCHENRANGLISTE"),
    empfehlungsbonus: env("CHANNEL_EMPFEHLUNGSBONUS"),

    // 👋 Kampagnen
    "agentur-events": env("CHANNEL_AGENTUR_EVENTS"),
    "events-rangliste": env("CHANNEL_EVENTS_RANGLISTE"),
    "tiktok-events": env("CHANNEL_TIKTOK_EVENTS"),
    "event-kalender": env("CHANNEL_EVENT_KALENDER"),
    "schaufenster-diamanten": env("CHANNEL_SCHAUFENSTER_DIAMANTEN"),
    "schaufenster-livezeit": env("CHANNEL_SCHAUFENSTER_LIVEZEIT"),

    // 💚 Chats
    hauptchat: env("CHANNEL_HAUPTCHAT"),
    "gaming-chat": env("CHANNEL_GAMING_CHAT"),
    "social-media": env("CHANNEL_SOCIAL_MEDIA"),
    "creator-livestreams": env("CHANNEL_CREATOR_LIVESTREAMS"),
    "creator-posts": env("CHANNEL_CREATOR_POSTS"),
    "creator-story": env("CHANNEL_CREATOR_STORY"),
    vorstellungsrunde: env("CHANNEL_VORSTELLUNGSRUNDE"),
    "vorschlaege": env("CHANNEL_VORSCHLAEGE"),
    feedback: env("CHANNEL_FEEDBACK"),
    geburtstag: env("CHANNEL_GEBURTSTAG"),
    "ki-vorstellung": env("CHANNEL_KI_ASSISTENT"),
    "aura-ki-chat": env("CHANNEL_AURA_KI_CHAT"),
  },
  // Welcome channel (where Aura greets new members)
  welcomeChannelId: env("CHANNEL_WELCOME"),
  // Default channel that "letztes Event" should read from
  defaultEventsChannelId: env("CHANNEL_DEFAULT_EVENTS"),
  // Founder / server owner Discord user ID
  founderDiscordId: env("FOUNDER_DISCORD_ID"),
  // Comma-separated names to exclude from weekly ranking (e.g. agency accounts)
  rankingExcludeNames: env("RANKING_EXCLUDE_NAMES")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean),
};

export type ChannelKey = keyof typeof config.channels;
