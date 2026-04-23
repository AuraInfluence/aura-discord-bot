
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type Guild,
  type TextChannel,
  type MessageReaction,
  type User as DJSUser,
} from "discord.js";
import { config } from "./config.js";
import { detectIntent } from "./intent.js";
import { askAura, type HistoryMessage } from "./openai.js";
import {
  fetchChannelMessages,
  messagesToContext,
  getLatestJoinFromChannel,
  extractImageUrls,
} from "./discord-helpers.js";

const TRIGGER_RE = /(^|\s)(!aura|@aura|\.aura|!ki|@ki|\.ki)(\b|[\s,.:!?]|$)/i;
const CHANNEL_MENTION_RE = /<#(\d+)>/g;

// ─── Greeting system ─────────────────────────────────────────────────────────

const GREETINGS = [
  "Hey!", "Jo!", "Servus!", "Na?", "Moin!", "Was geht?",
  "Yo!", "Nabend!", "Alles klar?", "Na, alles fit?",
  "Tach!", "Hey du!", "Na, wie läuft's?", "Moinsen!", "Grüß dich!",
  "Hallo!", "Oida!", "Joa!", "Digga, hey!",
  "Hey hey!", "Moin moin!", "Na, alter?", "Läuft bei dir?",
];
const GREET_COOLDOWN_MS = 30 * 60 * 1000;
const lastGreeted = new Map<string, number>();

function getGreeting(userId: string): string | null {
  const now = Date.now();
  const last = lastGreeted.get(userId) ?? 0;
  if (now - last < GREET_COOLDOWN_MS) return null;
  lastGreeted.set(userId, now);
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!;
}

// ─── Conversation history ─────────────────────────────────────────────────────

const HISTORY_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY_TURNS = 10; // keep last 10 exchanges (20 messages)

interface ConvSession {
  messages: HistoryMessage[];
  lastActive: number;
}

const conversationSessions = new Map<string, ConvSession>();

// Tracks users who were asked "In welcher Stadt?" — maps userId → channelId
const pendingWeather = new Map<string, string>();

function getHistory(userId: string): HistoryMessage[] {
  const session = conversationSessions.get(userId);
  if (!session) return [];
  if (Date.now() - session.lastActive > HISTORY_EXPIRY_MS) {
    conversationSessions.delete(userId);
    return [];
  }
  return session.messages;
}

function addToHistory(userId: string, userMsg: string, botReply: string): void {
  const existing = conversationSessions.get(userId);
  const messages: HistoryMessage[] = existing ? [...existing.messages] : [];
  messages.push({ role: "user", content: userMsg });
  messages.push({ role: "assistant", content: botReply });
  // Keep only the last N turns
  const trimmed = messages.slice(-MAX_HISTORY_TURNS * 2);
  conversationSessions.set(userId, { messages: trimmed, lastActive: Date.now() });
}

// ─── Reaction system ──────────────────────────────────────────────────────────

interface PendingReaction {
  userId: string;
  channelId: string;
  expiresAt: number;
  emojis: string[]; // which emojis the bot added (in order)
}
const pendingReactions = new Map<string, PendingReaction>();
const REACTION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse the optional [REACTIONS: emoji1 emoji2 ...] tag the AI may append.
 * Returns the cleaned text and the emoji list (empty if no tag found).
 */
/** Returns true only for actual Unicode emoji characters (not digits or plain text). */
function isValidEmoji(token: string): boolean {
  if (!token || /^\d+$/.test(token)) return false; // reject bare numbers
  // Must contain at least one emoji codepoint
  return /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(token);
}

function parseReactionTag(text: string): { clean: string; emojis: string[] } {
  // Trim trailing whitespace/newlines before matching
  const trimmed = text.trimEnd();
  const match = trimmed.match(/\[REACTIONS:\s*([^\]]+)\]\s*$/);
  if (!match) return { clean: text, emojis: [] };
  const raw = match[1]!.trim().split(/\s+/).slice(0, 4);
  // Keep only real emoji — discard numbers, plain text, or invalid tokens
  const emojis = raw.filter(isValidEmoji);
  const clean = trimmed.slice(0, match.index).trimEnd();
  return { clean: clean || text, emojis };
}

/**
 * Send a bot reply.
 * If the AI included a [REACTIONS: ...] tag, strip it and add those emojis.
 */
async function sendAuraReply(
  message: Message,
  rawText: string,
  greetFn: (t: string) => string,
): Promise<void> {
  const { clean, emojis } = parseReactionTag(rawText);
  const final = greetFn(clean.slice(0, 1880));
  const sent = await message.reply(final);

  if (emojis.length > 0) {
    try {
      for (const emoji of emojis) {
        await sent.react(emoji);
      }
      pendingReactions.set(sent.id, {
        userId: message.author.id,
        channelId: message.channelId,
        expiresAt: Date.now() + REACTION_EXPIRY_MS,
        emojis,
      });
    } catch {
      // Missing react permission — ignore silently
    }
  }
}

/**
 * Same as sendAuraReply but for messages sent to a channel directly
 * (used in the reaction follow-up flow where we have no original Message).
 */
async function sendAuraReplyToChannel(
  channel: TextChannel,
  mentionUserId: string,
  rawText: string,
  reactingUserId: string,
): Promise<void> {
  const { clean, emojis } = parseReactionTag(rawText);
  const sent = await channel.send(`<@${mentionUserId}> ${clean.slice(0, 1880)}`);

  if (emojis.length > 0) {
    try {
      for (const emoji of emojis) {
        await sent.react(emoji);
      }
      pendingReactions.set(sent.id, {
        userId: reactingUserId,
        channelId: channel.id,
        expiresAt: Date.now() + REACTION_EXPIRY_MS,
        emojis,
      });
    } catch {
      // Missing react permission — ignore silently
    }
  }
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Aura ist online als ${c.user.tag}`);
  const missingChannels = Object.entries(config.channels)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missingChannels.length > 0) {
    console.warn(`⚠️  Fehlende Channel-IDs: ${missingChannels.join(", ")}.`);
  }
});

// ─── Pingsync parser ─────────────────────────────────────────────────────────

interface PingsyncEntry {
  streamer: string;
  title: string;
  viewers: string;
  timestamp: number;
  ended: boolean;
  roleMention: string | null;
}

function parsePingsyncMsg(m: Message): PingsyncEntry | null {
  if (!m.embeds || m.embeds.length === 0) return null;
  const embed = m.embeds[0];
  if (!embed) return null;

  const rawTitle = embed.title ?? "";
  if (!rawTitle) return null;

  // Extract role mention from message content or from mentions.roles
  const roleMentionMatch = m.content.match(/<@&(\d+)>/);
  const roleFromMentions = m.mentions.roles.first();
  const roleMention = roleMentionMatch
    ? `<@&${roleMentionMatch[1]}>`
    : roleFromMentions
      ? `<@&${roleFromMentions.id}>`
      : null;

  // ── Format A: Livestream (Pingsync with fields) ──
  // Embed has "Streamer:" field. Title = "⚫ StreamTitle Stream beendet"
  const streamerField = embed.fields?.find((f) =>
    /streamer|creator|username|benutzer|nutzer/i.test(f.name),
  );
  const viewerField = embed.fields?.find((f) =>
    /gesamtzuschauer|zuschauer|views?|klicks?/i.test(f.name),
  );

  if (streamerField) {
    const streamTitle = rawTitle
      .replace(/^[⚫🟢🔴•\s]+/, "")
      .replace(/\s*(stream)\s+beendet\s*$/i, "")
      .trim();
    const ended =
      /beendet/i.test(rawTitle) ||
      /beendet/i.test(embed.description ?? "");
    return {
      streamer: streamerField.value.trim(),
      title: streamTitle,
      viewers: viewerField?.value ?? "",
      timestamp: m.createdTimestamp,
      ended,
      roleMention,
    };
  }

  // ── Format B: Video/Story post (Pingsync without fields) ──
  // Title = "{CreatorName} hat ein Video/Story auf TikTok gepostet"
  // Description = hashtags / caption
  const isPostFormat = /hat\s+(ein|eine)\s+(neues?\s+)?(video|story|reel|post|tiktok)/i.test(rawTitle);
  if (isPostFormat) {
    const creatorName = rawTitle
      .replace(/\s+hat\s+(ein|eine)?\s*(neues?\s+)?(video|story|reel|post|tiktok).*$/i, "")
      .trim();
    const caption = embed.description?.trim() || "";
    return {
      streamer: creatorName || m.author?.username || "Creator",
      title: caption || rawTitle,
      viewers: "",
      timestamp: m.createdTimestamp,
      ended: false,
      roleMention,
    };
  }

  // ── Fallback: generic embed with title ──
  const cleanTitle = rawTitle
    .replace(/^[⚫🟢🔴•\s]+/, "")
    .replace(/\s*beendet\s*$/i, "")
    .trim();
  if (!cleanTitle) return null;

  return {
    streamer: m.author?.username ?? "Creator",
    title: cleanTitle,
    viewers: "",
    timestamp: m.createdTimestamp,
    ended: /beendet/i.test(rawTitle),
    roleMention,
  };
}

// ─── Deduplication ───────────────────────────────────────────────────────────

interface DedupEntry extends PingsyncEntry {
  count: number;
}

function deduplicateEntries(entries: PingsyncEntry[]): DedupEntry[] {
  const result: DedupEntry[] = [];
  for (const entry of entries) {
    const last = result[result.length - 1];
    if (last && last.streamer === entry.streamer) {
      last.count++;
      last.timestamp = entry.timestamp;
    } else {
      result.push({ ...entry, count: 1 });
    }
  }
  return result;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function cleanCaption(text: string): string {
  return text
    .replace(/@(\S+)/g, (_, name) => `\`@${name}\``) // escape TikTok @mentions
    .trim();
}

function formatPingsyncEntries(
  entries: PingsyncEntry[],
  label: string,
  channelId: string,
): string {
  const deduped = deduplicateEntries(entries).slice(-5).reverse();
  const lines = deduped.slice(0, 5).map((e, i) => {
    const relTime = `<t:${Math.floor(e.timestamp / 1000)}:R>`;
    const who = e.roleMention ?? `\`${e.streamer}\``;
    const viewerCount = e.viewers ? e.viewers.replace(/[^\d]/g, "").trim() : "";
    const viewers = viewerCount ? ` · ${viewerCount} 👁️` : "";
    const times = e.count > 1 ? ` ×${e.count}` : "";
    return `**${i + 1}.** ${who}${times}${viewers} · ${relTime}`;
  });
  return `Zuletzt ${label} in <#${channelId}>:\n${lines.join("\n")}\n\n*Neueste oben, ältere darunter.*`;
}

// ─── Channel context helper ──────────────────────────────────────────────────

async function buildChannelContext(
  guild: Guild,
  channelId: string,
  label: string,
  limit = 40,
): Promise<string> {
  try {
    const msgs = await fetchChannelMessages(guild, channelId, limit);
    return `Inhalte aus ${label} (<#${channelId}>):\n\n${messagesToContext(msgs)}`;
  } catch {
    return `(Kanal <#${channelId}> konnte nicht gelesen werden – evtl. fehlende Rechte.)`;
  }
}

async function buildChannelContextWithImages(
  guild: Guild,
  channelId: string,
  label: string,
  limit = 40,
): Promise<{ context: string; imageUrls: string[] }> {
  try {
    const msgs = await fetchChannelMessages(guild, channelId, limit);
    const context = `Inhalte aus ${label} (<#${channelId}>):\n\n${messagesToContext(msgs)}`;
    const imageUrls = msgs.flatMap(extractImageUrls).slice(0, 6);
    return { context, imageUrls };
  } catch {
    return {
      context: `(Kanal <#${channelId}> konnte nicht gelesen werden – evtl. fehlende Rechte.)`,
      imageUrls: [],
    };
  }
}

// ─── Weather fetch ────────────────────────────────────────────────────────────

async function fetchWeather(location: string): Promise<string> {
  try {
    const encoded = encodeURIComponent(location);
    const res = await fetch(`https://wttr.in/${encoded}?format=j1&lang=de`);
    if (!res.ok) throw new Error(`wttr.in status ${res.status}`);
    const data = await res.json() as {
      current_condition: Array<{
        temp_C: string; FeelsLikeC: string; humidity: string;
        windspeedKmph: string; weatherDesc: Array<{ value: string }>;
      }>;
      nearest_area: Array<{ areaName: Array<{ value: string }>; country: Array<{ value: string }> }>;
      weather: Array<{ maxtempC: string; mintempC: string }>;
    };
    const cur = data.current_condition[0];
    const area = data.nearest_area[0];
    const today = data.weather[0];
    if (!cur || !area || !today) throw new Error("Unexpected wttr.in structure");

    const city = area.areaName[0]?.value ?? location;
    const country = area.country[0]?.value ?? "";
    const desc = cur.weatherDesc[0]?.value ?? "";
    return (
      `Wetter in **${city}${country ? `, ${country}` : ""}**:\n` +
      `🌡️ Aktuell: **${cur.temp_C}°C** (gefühlt ${cur.FeelsLikeC}°C)\n` +
      `📋 Zustand: ${desc}\n` +
      `🌡️ Tageswerte: ${today.mintempC}°C – ${today.maxtempC}°C\n` +
      `💧 Luftfeuchtigkeit: ${cur.humidity}%\n` +
      `💨 Wind: ${cur.windspeedKmph} km/h`
    );
  } catch (err) {
    console.error("Wetter-Fehler:", err);
    return `Wetterdaten für "${location}" konnten gerade nicht abgerufen werden.`;
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

async function handleTrigger(message: Message): Promise<void> {
  if (!message.guild) return;
  const guild = message.guild;
  const userId = message.author.id;

  // ── Owner-only: monday motivation test command ───────────────────────────
  if (/montag\s*test/i.test(message.content) && userId === guild.ownerId) {
    await postMondayMotivation({ force: true });
    await message.reply("✅ Montags-Motivation wurde gepostet!");
    return;
  }

  // ── Owner-only: sunday reminder test command ──────────────────────────────
  if (/sonntag\s*test/i.test(message.content) && userId === guild.ownerId) {
    await postSundayReminder({ force: true });
    await message.reply("✅ Sonntags-Erinnerung wurde gepostet!");
    return;
  }

  // ── Owner-only: friday message test command ──────────────────────────────
  if (/freitag\s*test/i.test(message.content) && userId === guild.ownerId) {
    await postFridayMessage({ force: true });
    await message.reply("✅ Freitags-Nachricht wurde gepostet!");
    return;
  }

  // ── Owner-only: weekly ranking test command ──────────────────────────────
  if (/wochenrangliste\s*test/i.test(message.content) && userId === guild.ownerId) {
    await message.reply("📊 Starte Wochenranglisten-Test — lese Creator-Daten der letzten 7 Tage...");
    const { posted } = await postWeeklyRanking({ force: true });
    if (!posted) {
      await message.reply("Konnte die Rangliste nicht erstellen — prüfe ob der #wochenrangliste Kanal korrekt konfiguriert ist.");
    } else {
      await message.reply("✅ Wochenrangliste wurde gepostet!");
    }
    return;
  }

  // ── Owner-only: birthday test command ────────────────────────────────────
  if (/geburtstag\s*test/i.test(message.content) && userId === guild.ownerId) {
    await message.reply("🎂 Starte Geburtstags-Test — überprüfe den #geburtstag Kanal für heute...");
    const { found } = await checkAndSendBirthdays({ force: true });
    if (found === 0) {
      await message.reply("Kein Geburtstag für heute im Kanal gefunden. Trage ein Datum mit heutigem Tag ein (z.B. `22.04`) damit der Test funktioniert.");
    } else {
      await message.reply(`✅ ${found} Geburtstags-Glückwunsch${found > 1 ? "e" : ""} wurden im Hauptchat gepostet!`);
    }
    return;
  }

  const userHistory = getHistory(userId);
  const intent = detectIntent(message.content);

  // Greeting (30-min cooldown per user)
  const greeting = getGreeting(message.author.id);
  const greet = (text: string) =>
    greeting ? `${greeting}\n${text}` : text;

  // Keep typing indicator alive every 8s while processing (Discord clears it after 10s)
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping().catch(() => undefined);
    typingInterval = setInterval(() => {
      if ("sendTyping" in message.channel) {
        message.channel.sendTyping().catch(() => undefined);
      }
    }, 8000);
  }

  const stopTyping = () => {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
  };

  console.log(`📨 [${message.author.tag}] intent=${intent.kind} | "${message.content.slice(0, 80)}"`);

  try {
    // 0a. Date / time
    if (intent.kind === "datetime") {
      const now = new Date();
      const dateStr = now.toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
      const reply = await askAura(
        `Der Creator fragt nach Datum oder Uhrzeit. Die aktuelle Zeit in Berlin ist: ${dateStr}. Antworte kurz und freundlich.`,
        "",
        [],
        userHistory,
      );
      addToHistory(userId, message.content, reply);
      await sendAuraReply(message, reply, greet);
      return;
    }

    // 0b. Weather
    if (intent.kind === "weather") {
      if (!intent.location) {
        // No city given — ask and wait for the next message
        pendingWeather.set(userId, message.channelId);
        await sendAuraReply(message, "In welcher Stadt? 🌍", greet);
        return;
      }
      const weatherData = await fetchWeather(intent.location);
      const reply = await askAura(
        `Der Creator fragt nach dem Wetter. Hier sind die aktuellen Wetterdaten:\n\n${weatherData}\n\nGib eine freundliche, kurze Wetterauskunft auf Deutsch.`,
        "",
        [],
        userHistory,
      );
      addToHistory(userId, message.content, reply);
      await sendAuraReply(message, reply, greet);
      return;
    }

    // 0c. Compliment — give one back!
    if (intent.kind === "compliment") {
      const reply = await askAura(
        `Der Creator hat dir gerade ein Kompliment gemacht oder sich bedankt. Reagiere herzlich und gib ihm/ihr ein aufrichtiges, persönliches Kompliment zurück. Sei kreativ, authentisch und locker — kein generisches "Danke". Beziehe dich darauf, dass er/sie Teil der Aura Influence Agentur ist und als Creator aktiv ist. Max 2-3 Sätze.`,
        "",
        [],
        userHistory,
      );
      addToHistory(userId, message.content, reply);
      await sendAuraReply(message, reply, greet);
      return;
    }

    // 1. Newest member
    if (intent.kind === "newest-member") {
      const channelId = config.channels["neu-dazugekommen"];
      if (!channelId) {
        await message.reply(greet("Der Kanal `#neu-dazugekommen` ist nicht konfiguriert."));
        return;
      }
      const join = await getLatestJoinFromChannel(guild, channelId);
      if (!join) {
        await message.reply(greet(`Aktuell ist niemand neu in <#${channelId}>.`));
        return;
      }
      const when = `<t:${Math.floor(join.timestamp / 1000)}:R>`;
      const who = join.userId ? `<@${join.userId}>` : `**${join.authorTag}**`;
      await message.reply(
        greet(`Der/die neueste Creator ist ${who} — beigetreten ${when}. Willkommen im Server! Mehr in <#${channelId}>.`),
      );
      return;
    }

    // 2. Who is live / who was live
    if (intent.kind === "who-is-live") {
      const channelId = config.channels["creator-livestreams"];
      if (!channelId) {
        await message.reply(greet("Der Kanal `#creator-livestreams` ist nicht konfiguriert."));
        return;
      }
      const allMsgs = await fetchChannelMessages(guild, channelId, 30);
      const entries = allMsgs
        .map(parsePingsyncMsg)
        .filter((e): e is PingsyncEntry => e !== null);

      if (entries.length === 0) {
        await message.reply(greet(`In <#${channelId}> wurden noch keine Live-Benachrichtigungen gefunden.`));
        return;
      }

      const isCurrentlyLive = /aktuell|gerade|jetzt|\bist\b|\bsind\b/i.test(message.content);
      const lastEntry = entries[entries.length - 1]!;

      if (isCurrentlyLive) {
        // Find all currently active (not ended) streams
        const liveNow = entries.filter((e) => !e.ended);

        if (liveNow.length > 0) {
          const lines = liveNow.map((e) => {
            const who = e.roleMention ?? `\`${e.streamer}\``;
            const title = e.title ? ` — „${e.title}"` : "";
            const viewers = e.viewers ? ` · ${e.viewers.replace(/[^\d]/g, "").trim()} 👁️` : "";
            return `🔴 ${who}${title}${viewers}`;
          });
          const listText = lines.join("\n");
          const MOTIVATIONS_ONE = [
            `\n\n💡 Ihr wollt auch live gehen? Jetzt ist der perfekte Moment — je mehr Creator gleichzeitig live sind, desto mehr Reichweite für alle!`,
            `\n\n🎯 Schaut rein und zeigt Support! Und wer selbst live gehen möchte — traut euch, jetzt ist ein guter Zeitpunkt!`,
            `\n\n🚀 Unterstützt euren Creator und wenn ihr selbst Lust habt — einfach live gehen, jeder Schritt zählt!`,
            `\n\n⭐ Schaut rein! Und für alle die noch zögern: Live gehen ist einfacher als ihr denkt — einfach anfangen!`,
            `\n\n🎙️ Support ist das Wichtigste! Und wer selbst noch nicht live war — heute wäre ein perfekter Tag dafür.`,
          ];
          const MOTIVATIONS_MANY = [
            `\n\n🔥 Gleich mehrere Creator sind live — schaut rein und zeigt eure Unterstützung!`,
            `\n\n💪 Richtig viel los gerade! Schaut rein bei euren Lieblings-Creatorn und hinterlasst ein Like!`,
            `\n\n🌟 Die Bühnen sind voll — perfekte Zeit, mal reinzuschauen und den Hype mitzunehmen!`,
            `\n\n🎉 Mehrere Streams gleichzeitig — das ist Energie! Und wer auch live möchte: einfach dazustoßen!`,
          ];
          const motiviation = liveNow.length === 1
            ? MOTIVATIONS_ONE[Math.floor(Math.random() * MOTIVATIONS_ONE.length)]
            : MOTIVATIONS_MANY[Math.floor(Math.random() * MOTIVATIONS_MANY.length)];
          await message.reply(greet(`Aktuell live in <#${channelId}>:\n${listText}${motiviation}`));
        } else {
          const MOTIVATIONS_NOBODY = [
            `Wer jetzt startet, hat die volle Aufmerksamkeit für sich! 🎯`,
            `Perfekte Zeit, das zu ändern — live gehen ist eine der stärksten Möglichkeiten um zu wachsen. 🚀`,
            `Ihr habt alle die Power dazu! Startet einfach, auch ohne perfekte Vorbereitung. 🎙️`,
            `Wer traut sich als Erstes? Die Zuschauer warten schon auf euch! ⭐`,
            `Kein besserer Moment um live zu gehen und aufzufallen. 💪`,
            `Je öfter ihr live geht, desto schneller wächst ihr — das ist eure Chance! 📈`,
            `Ran ans Handy und live gehen, ihr seid nicht zum Zuschauen da! 😄`,
            `Vielleicht wartet TikTok genau auf euch — traut euch! 🔴`,
            `Wer jetzt live geht, hat die beste Chance auf Sichtbarkeit. 🌟`,
            `Jeder Anfang zählt. Auch ein 5-Minuten-Live macht was aus! ⚡`,
          ];
          const motivation = MOTIVATIONS_NOBODY[Math.floor(Math.random() * MOTIVATIONS_NOBODY.length)]!;
          await message.reply(greet(`Gerade ist niemand live in <#${channelId}>.\n\n${motivation}`));
        }
        return;
      }

      const MOTIVATIONS_WAS_LIVE = [
        `\n\n💪 Stark! Wer regelmäßig live geht, wächst am schnellsten — macht weiter so!`,
        `\n\n🚀 Live gehen zahlt sich aus! Je öfter ihr dabei seid, desto mehr Reichweite sammelt ihr.`,
        `\n\n🎯 Gut gemacht! Und wer noch nicht dabei war — das nächste Live wartet schon auf euch!`,
        `\n\n⭐ Diese Creator machen es vor — live gehen ist der direkteste Weg zu euren Followern!`,
        `\n\n🔴 Weiter so! Konsistenz beim Live gehen ist der Schlüssel zum Erfolg auf TikTok.`,
      ];
      const liveMotivation = MOTIVATIONS_WAS_LIVE[Math.floor(Math.random() * MOTIVATIONS_WAS_LIVE.length)]!;
      await message.reply(greet(formatPingsyncEntries(entries, "live", channelId) + liveMotivation));
      return;
    }

    // 3. Latest event
    if (intent.kind === "latest-event") {
      const q = message.content.toLowerCase();
      const channelId =
        (/tiktok/i.test(q) && config.channels["tiktok-events"]) ||
        (/agentur[\s-]*event/i.test(q) && config.channels["agentur-events"]) ||
        (/kalender/i.test(q) && config.channels["event-kalender"]) ||
        config.channels["tiktok-events"] ||
        config.channels["agentur-events"] ||
        config.channels["event-kalender"];
      if (!channelId) {
        await message.reply(greet("Es ist noch kein Events-Kanal konfiguriert."));
        return;
      }
      const messages = await fetchChannelMessages(guild, channelId, 20);

      if (messages.length === 0) {
        await message.reply(greet(`In <#${channelId}> wurden noch keine Events gefunden.`));
        return;
      }
      // Finde die neueste Nachricht mit echtem Inhalt (Bild, Text > 20 Zeichen, oder Embed)
      const reversed = [...messages].reverse(); // neueste zuerst
      const meaningful = reversed.find(
        (m) =>
          m.attachments.size > 0 ||
          m.embeds.length > 0 ||
          (m.content && m.content.replace(/<[^>]+>/g, "").trim().length > 20),
      ) ?? reversed[0]!;

      // Sammle diese Nachricht + bis zu 2 direkt folgende (könnte mehrteilig sein)
      const meaningfulIdx = messages.indexOf(meaningful);
      const eventMsgs = messages.slice(Math.max(0, meaningfulIdx - 1), meaningfulIdx + 3);
      const imageUrls = eventMsgs.flatMap(extractImageUrls).slice(0, 6);
      const context = `Neuestes Event in <#${channelId}> (gepostet <t:${Math.floor(meaningful.createdTimestamp / 1000)}:F>):\n\n${messagesToContext(eventMsgs)}`;
      const reply = await askAura(
        `Das ist das neueste Event aus dem TikTok-Events-Kanal. Erkläre es: Was ist es, wer kann mitmachen, wie funktioniert es, welcher Zeitraum? Falls ein Bild beigefügt ist, analysiere es und ergänze alle Details daraus. Verlinke den Kanal als <#${channelId}>. Antworte auf Deutsch.`,
        context,
        imageUrls,
        userHistory,
      );
      addToHistory(userId, message.content, reply);
      await sendAuraReply(message, reply, greet);
      return;
    }

    // 4. What's new on the server
    if (intent.kind === "whats-new") {
      const newsChannels: Array<{ key: keyof typeof config.channels; label: string }> = [
        { key: "updates", label: "Updates" },
        { key: "information", label: "Information" },
        { key: "neu-dazugekommen", label: "Neue Creator" },
        { key: "monatsrangliste", label: "Monatsrangliste" },
        { key: "empfehlungsbonus", label: "Empfehlungsbonus" },
        { key: "agentur-events", label: "Agentur-Events" },
        { key: "tiktok-events", label: "TikTok-Events" },
        { key: "event-kalender", label: "Event-Kalender" },
        { key: "schaufenster-diamanten", label: "Schaufenster Diamanten" },
        { key: "schaufenster-livezeit", label: "Schaufenster Livezeit" },
        { key: "creator-posts", label: "Creator Posts" },
        { key: "creator-story", label: "Creator Story" },
        { key: "creator-livestreams", label: "Creator Livestreams" },
        { key: "vorstellungsrunde", label: "Vorstellungsrunde" },
        { key: "geburtstag", label: "Geburtstage" },
        { key: "umfragen", label: "Umfragen" },
        { key: "vorschlaege", label: "Vorschläge" },
        { key: "feedback", label: "Feedback" },
      ];

      // Compute Berlin-timezone day boundaries for "today" / "yesterday"
      const berlinMidnight = (daysAgo: number): number => {
        const now = new Date();
        // Format in Berlin time to get local year/month/day
        const parts = new Intl.DateTimeFormat("de-DE", {
          timeZone: "Europe/Berlin",
          year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(now);
        const day = Number(parts.find((p) => p.type === "day")!.value);
        const month = Number(parts.find((p) => p.type === "month")!.value) - 1;
        const year = Number(parts.find((p) => p.type === "year")!.value);
        // Midnight Berlin = UTC midnight minus Berlin offset
        const localMidnight = new Date(Date.UTC(year, month, day - daysAgo));
        // Use Intl to get actual Berlin offset
        const berlinOffset = (() => {
          const d = new Date(localMidnight);
          const utcStr = d.toLocaleString("en-US", { timeZone: "UTC" });
          const berlinStr = d.toLocaleString("en-US", { timeZone: "Europe/Berlin" });
          return (new Date(berlinStr).getTime() - new Date(utcStr).getTime());
        })();
        return localMidnight.getTime() - berlinOffset;
      };

      const { timeFilter } = intent;
      let afterTs: number;
      let beforeTs: number;
      let periodLabel: string;

      if (timeFilter === "today") {
        afterTs = berlinMidnight(0);
        beforeTs = Date.now();
        periodLabel = "heute";
      } else if (timeFilter === "yesterday") {
        afterTs = berlinMidnight(1);
        beforeTs = berlinMidnight(0);
        periodLabel = "gestern";
      } else {
        afterTs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        beforeTs = Date.now();
        periodLabel = "den letzten 7 Tagen";
      }

      // Pingsync channels need special handling — parse structured entries instead of raw text
      const PINGSYNC_KEYS = new Set(["creator-posts", "creator-story", "creator-livestreams"]);

      const results = await Promise.all(
        newsChannels
          .filter(({ key }) => config.channels[key])
          .map(async ({ key, label }) => {
            const id = config.channels[key]!;
            try {
              if (PINGSYNC_KEYS.has(key)) {
                // --- Pingsync channel: parse entries, group by creator ---
                const allMsgs = await fetchChannelMessages(guild, id, 80);
                const entries = allMsgs
                  .map(parsePingsyncMsg)
                  .filter((e): e is PingsyncEntry => e !== null)
                  .filter((e) => e.timestamp >= afterTs && e.timestamp < beforeTs);
                if (entries.length === 0) return null;

                // Group by streamer — track both mention and display name
                const byCreator = new Map<string, { count: number; mention: string | null }>();
                for (const e of entries) {
                  const key = e.streamer;
                  const existing = byCreator.get(key);
                  if (existing) {
                    existing.count += 1;
                    if (!existing.mention && e.roleMention) existing.mention = e.roleMention;
                  } else {
                    byCreator.set(key, { count: 1, mention: e.roleMention });
                  }
                }
                const lines = [...byCreator.entries()]
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([name, { count, mention }]) => {
                    const display = mention ?? name;
                    return `  - ${display}: ${count}×`;
                  });
                return `**${label}** (<#${id}>) — ${entries.length} Beitrag/Beiträge von ${byCreator.size} Creator(n):\n${lines.join("\n")}`;
              } else {
                // --- Regular channel: show last 1-2 messages in window ---
                const msgs = await fetchChannelMessages(guild, id, timeFilter === "week" ? 10 : 40);
                const inWindow = msgs.filter(
                  (m) => m.createdTimestamp >= afterTs && m.createdTimestamp < beforeTs,
                );
                if (inWindow.length === 0) return null;
                const newest = inWindow[inWindow.length - 1]!;
                // Only show 2 most recent messages to keep context clean
                const preview = messagesToContext(inWindow.slice(-2));
                return `**${label}** (<#${id}>) — ${inWindow.length} Nachricht(en), zuletzt <t:${Math.floor(newest.createdTimestamp / 1000)}:R>:\n${preview}`;
              }
            } catch {
              return null;
            }
          }),
      );

      const activeChannels = results.filter((r): r is string => r !== null);
      if (activeChannels.length === 0) {
        await message.reply(greet(`In ${periodLabel} gab es keine erkennbaren Neuigkeiten in den Info-Kanälen.`));
        return;
      }

      const context = activeChannels.join("\n\n---\n\n").slice(0, 8000);
      const prompt = timeFilter === "week"
        ? `Der Creator fragt: "${message.content}". Fasse die neuesten Aktivitäten auf dem Server kurz zusammen. Gruppiere nach Thema. Erwähne keine Chat-Unterhaltungen — nur Infos, Events, Rankings, Creator-Aktivitäten und Ankündigungen. Verlinke die jeweiligen Kanäle.`
        : `Der Creator fragt: "${message.content}". Erstelle eine strukturierte Übersicht was ${periodLabel} auf dem Server gepostet wurde. Gib für jeden aktiven Kanal an was und wie viel gepostet wurde. Verlinke Kanäle als <#ID>. Übernimm Discord-Rollen-Mentions (<@&ID>) aus dem Kontext exakt so — schreibe sie unverändert in deine Antwort damit die Creator markiert werden. Bleib präzise und faktisch — keine eigenen Interpretationen der Post-Inhalte.`;
      const reply = await askAura(prompt, context, [], userHistory);
      addToHistory(userId, message.content, reply);
      await sendAuraReply(message, reply, greet);
      return;
    }

    // 5. Channel summary
    if (intent.kind === "channel-summary") {

      // Special handler: Livemanager — read channel content directly
      if (intent.channel === "live-manager") {
        // Look up role from cache only (no heavy fetch)
        const liveManagerRole = guild.roles.cache.find(
          (r) => /live[\s-]?manage/i.test(r.name),
        );
        const roleMention = liveManagerRole ? `<@&${liveManagerRole.id}>` : "@Livemanager";

        const { context, imageUrls } = await buildChannelContextWithImages(
          guild,
          intent.channelId,
          `Kanal <#${intent.channelId}>`,
        );

        const reply = await askAura(
          `Der Creator fragt: "${message.content}". Erkläre wer die Livemanager der Agentur sind basierend auf dem Kanalinhalt. Die Rolle heißt ${roleMention}. Verlinke den Kanal als <#${intent.channelId}> und erwähne Personen mit @Mention wenn erkennbar.`,
          context,
          imageUrls,
          userHistory,
        );
        addToHistory(userId, message.content, reply);
        await sendAuraReply(message, reply, greet);
        return;
      }

      const isPingsyncChannel =
        intent.channel === "creator-posts" ||
        intent.channel === "creator-story" ||
        intent.channel === "creator-livestreams";

      if (isPingsyncChannel) {
        const allMsgs = await fetchChannelMessages(guild, intent.channelId, 50);

        const entries = allMsgs
          .map(parsePingsyncMsg)
          .filter((e): e is PingsyncEntry => e !== null);

        if (entries.length > 0) {
          const label =
            intent.channel === "creator-livestreams"
              ? "live"
              : intent.channel === "creator-story"
                ? "in der Story aktiv"
                : "gepostet";

          const MOTIVATIONS_VIDEO = [
            `\n\n🎬 Weiter so! Regelmäßige Posts sind der Schlüssel zum Wachstum — je öfter ihr postet, desto mehr Reichweite!`,
            `\n\n📱 Schaut rein und zeigt Support! Und wer selbst noch nicht gepostet hat — heute ist ein guter Tag dafür!`,
            `\n\n🚀 Konsistenz ist alles! Wer regelmäßig postet, wird von TikTok belohnt. Weiter so!`,
            `\n\n⭐ Videos sind eure Visitenkarte — je mehr ihr postet, desto mehr Leute lernen euch kennen!`,
            `\n\n💡 Jedes Video zählt! Auch ein kurzes Clip kann viral gehen — traut euch mehr zu posten!`,
            `\n\n🎯 Gut gemacht! Und an alle die noch zögern: einfach posten, Perfektion kommt mit der Zeit!`,
            `\n\n📈 Wer postet, wächst! Macht weiter so und bleibt aktiv — TikTok liebt aktive Creator!`,
          ];
          const MOTIVATIONS_STORY = [
            `\n\n📸 Stories sind perfekt um nahbar zu wirken! Je mehr ihr postet, desto enger wird die Bindung mit euren Followern.`,
            `\n\n💫 Story gepostet = Follower wissen, dass ihr aktiv seid! Macht weiter so!`,
            `\n\n🌟 Stories werden oft unterschätzt — dabei sind sie eine der besten Möglichkeiten um Reichweite zu steigern!`,
            `\n\n🔥 Regelmäßige Stories zeigen euren Followern, dass ihr präsent seid — weiter so!`,
            `\n\n✨ Story-Content verbindet! Wer noch keine Story gepostet hat — einfach anfangen, es lohnt sich!`,
            `\n\n🎯 Gut gemacht! Stories halten eure Community am Leben — bleibt aktiv!`,
          ];

          const motivation =
            intent.channel === "creator-story"
              ? MOTIVATIONS_STORY[Math.floor(Math.random() * MOTIVATIONS_STORY.length)]
              : intent.channel === "creator-posts"
                ? MOTIVATIONS_VIDEO[Math.floor(Math.random() * MOTIVATIONS_VIDEO.length)]
                : "";

          await message.reply(greet(formatPingsyncEntries(entries, label, intent.channelId) + (motivation ?? "")));
          return;
        }
        // Fall through to AI if no Pingsync entries found
      }

      const { context, imageUrls } = await buildChannelContextWithImages(guild, intent.channelId, `Kanal <#${intent.channelId}>`);
      const reply = await askAura(
        `Der Creator hat geschrieben: "${message.content}". Fasse die wichtigsten Punkte aus dem Kanal zusammen, erkläre sie kurz und freundlich und verlinke den Kanal immer als <#${intent.channelId}>. Falls Bilder vorhanden sind, analysiere sie und nutze deren Inhalt für die Antwort.`,
        context,
        imageUrls,
        userHistory,
      );
      addToHistory(userId, message.content, reply);
      await sendAuraReply(message, reply, greet);
      return;
    }

    // 5b. Creator — meine Stats
    if (intent.kind === "my-stats") {
      const member = message.member;
      if (!member) {
        await message.reply(greet("Deine Stats kann ich nur auf einem Server abrufen."));
        return;
      }

      const daysAgoMonday = (berlinWeekday() + 6) % 7;
      const weekFrom = berlinMidnightOf(daysAgoMonday);
      const weekTo = Date.now() + 1000;
      const ranking = await buildWeeklyRanking(guild, weekFrom, weekTo);

      // Match by roleMention first, then display name
      const memberRoleIds = new Set(member.roles.cache.keys());
      const displayName = member.displayName.toLowerCase();

      const entry = ranking.find((e) => {
        if (e.roleMention) {
          const m = e.roleMention.match(/<@&(\d+)>/);
          if (m && memberRoleIds.has(m[1]!)) return true;
        }
        const sn = e.streamer.toLowerCase();
        return sn.includes(displayName) || displayName.includes(sn);
      });

      if (!entry) {
        await message.reply(
          greet(
            `Diese Woche habe ich noch keine Aktivität von dir in den Creator-Kanälen gefunden.\n\n` +
            `Wertungsperiode läuft noch bis **Sonntag, 23:59 Uhr** 🗓️\n\n` +
            `📸 Story posten = 1 Pkt  ·  📹 Video posten = 2 Pkt  ·  🔴 Livestream starten = 3 Pkt\n\n` +
            `Jeder Punkt zählt — leg los! 💪`,
          ),
        );
        return;
      }

      const rank = ranking.indexOf(entry) + 1;
      const pts = weekScore(entry);
      const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
      const detail = [
        entry.stories > 0 ? `${entry.stories}x 📸 Story` : "",
        entry.posts > 0 ? `${entry.posts}x 📹 Video` : "",
        entry.streams > 0 ? `${entry.streams}x 🔴 Livestream` : "",
      ].filter(Boolean).join("  ·  ");

      const berlinFmt = (ts: number) =>
        new Date(ts).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" });

      await message.reply(
        greet(
          `Deine aktuellen Stats für diese Woche (${berlinFmt(weekFrom)} – heute):\n\n` +
          `${medal} Platz **${rank}** von ${ranking.length} Creatorn\n` +
          `⭐ **${pts} Punkt${pts !== 1 ? "e" : ""}** insgesamt\n` +
          (detail ? `📊 ${detail}\n` : "") +
          `\nDie Rangliste wird **Montag um 09:00 Uhr** veröffentlicht. Bis Sonntag 23:59 Uhr kannst du noch Punkte sammeln! 🏆`,
        ),
      );
      return;
    }

    // 5c. Owner — Alle Stats
    if (intent.kind === "owner-stats") {
      const isOwner = message.author.id === guild.ownerId;
      if (!isOwner) {
        await message.reply(greet("Diese Übersicht ist nur für den Server-Inhaber verfügbar. 🔒"));
        return;
      }

      // Current week (this Monday → now)
      const daysAgoMonday = (berlinWeekday() + 6) % 7;
      const currentWeekFrom = berlinMidnightOf(daysAgoMonday);
      const currentWeekTo = Date.now() + 1000;

      // Last 4 completed weeks (28 days → this Monday)
      const allTimeFrom = berlinMidnightOf(daysAgoMonday + 28);
      const allTimeTo = berlinMidnightOf(daysAgoMonday);

      const [currentRanking, allTimeRanking] = await Promise.all([
        buildWeeklyRanking(guild, currentWeekFrom, currentWeekTo),
        buildWeeklyRanking(guild, allTimeFrom, allTimeTo),
      ]);

      const berlinFmt = (ts: number) =>
        new Date(ts).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" });

      const fmtEntry = (e: WeeklyCreatorEntry, rank: number): string => {
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
        const who = e.roleMention ?? `**${e.streamer}**`;
        const pts = weekScore(e);
        const detail = [
          e.stories > 0 ? `${e.stories}x 📸` : "",
          e.posts > 0 ? `${e.posts}x 📹` : "",
          e.streams > 0 ? `${e.streams}x 🔴` : "",
        ].filter(Boolean).join(" · ");
        return `${medal} ${who} — **${pts} Pkt** (${detail})`;
      };

      const currentLines = currentRanking.length === 0
        ? ["Noch keine Aktivität diese Woche."]
        : currentRanking.map((e, i) => fmtEntry(e, i + 1));

      const allTimeLines = allTimeRanking.length === 0
        ? ["Keine Daten für die letzten 4 Wochen."]
        : allTimeRanking.map((e, i) => fmtEntry(e, i + 1));

      const lines = [
        `🔒 **Creator-Übersicht** (nur für dich sichtbar, da du Inhaber bist)`,
        ``,
        `**📅 Aktuelle Woche** (${berlinFmt(currentWeekFrom)} – heute):`,
        ...currentLines,
        ``,
        `**📊 Letzte 4 Wochen** (${berlinFmt(allTimeFrom)} – ${berlinFmt(allTimeTo - 1)}):`,
        ...allTimeLines,
        ``,
        `📸 1 Pkt  ·  📹 2 Pkt  ·  🔴 3 Pkt`,
      ];

      await message.reply(lines.join("\n").slice(0, 1980));
      return;
    }

    // 6. Free question
    const explicitMentions = Array.from(message.content.matchAll(CHANNEL_MENTION_RE))
      .map((m) => m[1])
      .filter((id): id is string => Boolean(id));

    const contextParts: string[] = [];
    const allImageUrls: string[] = [];

    // Only read channel content when channels are explicitly mentioned in the message.
    // For general/casual questions, channel content is irrelevant and misleading.
    if (explicitMentions.length > 0) {
      for (const channelId of explicitMentions.slice(0, 3)) {
        const { context, imageUrls: imgs } = await buildChannelContextWithImages(guild, channelId, `Kanal <#${channelId}>`);
        contextParts.push(context);
        allImageUrls.push(...imgs);
      }
    }

    // Also include any images the user attached to their own message
    allImageUrls.push(...extractImageUrls(message));

    const channelHints = Object.entries(config.channels)
      .filter(([, id]) => id)
      .map(([name, id]) => `- ${name}: <#${id}>`)
      .join("\n");
    if (channelHints) {
      contextParts.push(`Verfügbare Server-Kanäle:\n${channelHints}`);
    }

    // Inject founder info when asked about the Gründer/owner
    if (/gr(ü|ue)nder|inhaber|besitzer|owner|wer hat.*server|wer hat.*agentur/i.test(message.content)) {
      contextParts.push(`Wichtige Info: Der Gründer/Inhaber dieses Discord-Servers und der Agentur ist <@${guild.ownerId}>. Erwähne diese Person immer mit diesem @Mention. Der Gründer ist männlich (Inhaber, nicht Inhaberin).`);
    }

    const reply = await askAura(
      message.content,
      contextParts.join("\n\n---\n\n"),
      allImageUrls.slice(0, 6),
      userHistory,
    );
    addToHistory(userId, message.content, reply);
    await sendAuraReply(message, reply, greet);
  } catch (err) {
    console.error("Fehler beim Bearbeiten der Anfrage:", err);
    await message
      .reply("Da ist gerade etwas schiefgelaufen. Bitte versuch es gleich nochmal.")
      .catch(() => undefined);
  } finally {
    stopTyping();
  }
}

async function handleWeatherAnswer(message: Message, city: string): Promise<void> {
  const userId = message.author.id;
  const userHistory = getHistory(userId);
  const greeting = getGreeting(message.author.id);
  const greet = (text: string) => greeting ? `${greeting}\n${text}` : text;

  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping().catch(() => undefined);
  }

  const weatherData = await fetchWeather(city);
  const reply = await askAura(
    `Der Creator fragt nach dem Wetter. Hier sind die aktuellen Wetterdaten:\n\n${weatherData}\n\nGib eine freundliche, kurze Wetterauskunft auf Deutsch.`,
    "",
    [],
    userHistory,
  );
  addToHistory(userId, city, reply);
  await sendAuraReply(message, reply, greet);
}

client.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Pending weather: user was asked "In welcher Stadt?" — their next message is the city
    const pendingChannelId = pendingWeather.get(message.author.id);
    if (pendingChannelId && pendingChannelId === message.channelId) {
      pendingWeather.delete(message.author.id);
      // Extract city: strip any trigger prefix so plain "Berlin" or "@aura Berlin" both work
      const city = message.content
        .replace(TRIGGER_RE, "")
        .replace(/<@!?\d+>/g, "")
        .trim();
      if (city) {
        await handleWeatherAnswer(message, city);
        return;
      }
    }

    const triggeredByPrefix = TRIGGER_RE.test(message.content);
    const triggeredByMention = client.user !== null && message.mentions.has(client.user);
    if (!triggeredByPrefix && !triggeredByMention) return;
    await handleTrigger(message);
  } catch (err) {
    console.error("MessageCreate-Fehler:", err);
  }
});

// ─── Reaction handler ────────────────────────────────────────────────────────

client.on(Events.MessageReactionAdd, async (reaction: MessageReaction, user: DJSUser) => {
  try {
    if (user.bot) return;

    // Fetch partial reaction/message if needed
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const pending = pendingReactions.get(reaction.message.id);
    if (!pending) return;

    // Only the creator who started the conversation may use these reactions.
    // Silently remove reactions from everyone else so the count stays clean.
    if (pending.userId !== user.id) {
      await reaction.users.remove(user.id).catch(() => undefined);
      return;
    }

    if (Date.now() > pending.expiresAt) {
      pendingReactions.delete(reaction.message.id);
      return;
    }

    const emojiName = reaction.emoji.name ?? "";

    // Ignore clicks on emojis that weren't part of this reaction set
    if (!pending.emojis.includes(emojiName)) return;

    pendingReactions.delete(reaction.message.id);

    const channel = reaction.message.channel as TextChannel;

    // Tell the AI which emoji was clicked — it knows the context and responds accordingly
    const userMsg = `Der Creator hat mit ${emojiName} geantwortet.`;
    const history = getHistory(user.id);
    const reply = await askAura(userMsg, "", [], history);
    addToHistory(user.id, userMsg, reply);
    await sendAuraReplyToChannel(channel, user.id, reply, user.id);

  } catch (err) {
    console.error("ReactionAdd-Fehler:", err);
  }
});

// ─── Birthday system ──────────────────────────────────────────────────────────

/** Users already greeted today — key: `userId-YYYY-MM-DD` */
const birthdayGreetedToday = new Set<string>();

const BIRTHDAY_MESSAGES = [
  (mention: string, ownerMention: string) =>
    `🎂 Herzlichen Glückwunsch zum Geburtstag, ${mention}! 🎉\n\nIm Namen der **Aura Influence Agentur** wünschen wir dir einen wunderschönen Geburtstag, alles Liebe und weiter so viel Erfolg auf TikTok! 🚀✨\n\n${ownerMention} und das gesamte Aura-Team drücken dir ganz fest die Daumen — du rockst das! 🎊`,
  (mention: string, ownerMention: string) =>
    `🎉 Hey ${mention}, heute ist dein großer Tag! Alles Gute zum Geburtstag! 🥳🎂\n\nDie **Aura Influence Agentur** wünscht dir nur das Beste — bleib so motiviert wie du bist und mach weiter so! 💪🔥\n\n${ownerMention} und das komplette Team sind stolz auf dich! 🎁`,
  (mention: string, ownerMention: string) =>
    `🎊 Geburtstag-Alarm für ${mention}! 🎂🥳\n\nIm Namen der **Aura Influence Agentur** wünschen wir dir alles Glück der Welt, viel Gesundheit und einen absoluten Traumtag! ✨🌟\n\n${ownerMention} schickt dir die herzlichsten Glückwünsche — heute wird gefeiert! 🎉`,
];

/** Returns today's date in Berlin timezone as `YYYY-MM-DD`. */
function berlinDateKey(): string {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const d = parts.find((p) => p.type === "day")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const y = parts.find((p) => p.type === "year")!.value;
  return `${y}-${m}-${d}`;
}

/** Returns current Berlin hour (0–23). */
function berlinHour(): number {
  return Number(
    new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin", hour: "2-digit", hour12: false,
    }).formatToParts(new Date()).find((p) => p.type === "hour")!.value,
  );
}

/** Returns the Unix timestamp (ms) of midnight Berlin time, `daysAgo` days back. */
function berlinMidnightOf(daysAgo: number): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const day   = Number(parts.find((p) => p.type === "day")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const year  = Number(parts.find((p) => p.type === "year")!.value);
  const localMidnight = new Date(Date.UTC(year, month, day - daysAgo));
  const berlinOffset = (() => {
    const utcStr    = localMidnight.toLocaleString("en-US", { timeZone: "UTC" });
    const berlinStr = localMidnight.toLocaleString("en-US", { timeZone: "Europe/Berlin" });
    return new Date(berlinStr).getTime() - new Date(utcStr).getTime();
  })();
  return localMidnight.getTime() - berlinOffset;
}

/** Returns today's day and month in Berlin timezone. */
function berlinDayMonth(): { day: number; month: number } {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit",
  }).formatToParts(new Date());
  return {
    day: Number(parts.find((p) => p.type === "day")!.value),
    month: Number(parts.find((p) => p.type === "month")!.value),
  };
}

/**
 * Try to parse a birthday date (DD.MM or DD.MM.YYYY) from a string.
 * Returns null if no valid date is found.
 */
function parseBirthdayDate(text: string): { day: number; month: number } | null {
  const match = text.match(/\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-]\d{2,4})?\b/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { day, month };
}

async function checkAndSendBirthdays(opts?: { force?: boolean }): Promise<{ found: number }> {
  try {
    // Only send between 9:00 and 9:59 AM Berlin time (unless forced for testing)
    if (!opts?.force && berlinHour() !== 9) return { found: 0 };

    const todayKey = berlinDateKey();
    const { day: todayDay, month: todayMonth } = berlinDayMonth();

    const guild = client.guilds.cache.first();
    if (!guild) return { found: 0 };

    const birthdayChannelId = config.channels["geburtstag"];
    const hauptchatId = config.channels["hauptchat"];
    if (!birthdayChannelId || !hauptchatId) return { found: 0 };

    const hauptchat = guild.channels.cache.get(hauptchatId) as TextChannel | undefined;
    if (!hauptchat?.isTextBased()) return { found: 0 };

    const bdCh = guild.channels.cache.get(birthdayChannelId);
    if (!bdCh?.isTextBased()) return { found: 0 };

    const messages = await (bdCh as TextChannel).messages.fetch({ limit: 100 });
    const ownerMention = `<@${guild.ownerId}>`;
    let found = 0;

    for (const [, msg] of messages) {
      if (msg.author.bot) continue;

      // If the message explicitly mentions another user, that user has the birthday.
      // Otherwise the author themselves posted their birthday.
      const mentionedUser = msg.mentions.users.first();
      const birthdayUserId = mentionedUser?.id ?? msg.author.id;

      const parsed = parseBirthdayDate(msg.content);
      if (!parsed) continue;
      if (parsed.day !== todayDay || parsed.month !== todayMonth) continue;

      // In force/test mode skip dedup so the owner can see output
      const greetKey = `${birthdayUserId}-${todayKey}`;
      if (!opts?.force && birthdayGreetedToday.has(greetKey)) continue;
      birthdayGreetedToday.add(greetKey);
      found++;

      // Build mention string: user mention + any role mention from the birthday message
      const roleMentionStr = msg.mentions.roles.first()
        ? ` ${msg.mentions.roles.map((r) => `<@&${r.id}>`).join(" ")}`
        : "";
      const creatorMention = `<@${birthdayUserId}>${roleMentionStr}`;

      const template = BIRTHDAY_MESSAGES[Math.floor(Math.random() * BIRTHDAY_MESSAGES.length)]!;
      const text = template(creatorMention, ownerMention);

      await hauptchat.send(text);
      console.log(`🎂 Birthday greeting sent for user ${birthdayUserId}`);
    }
    return { found };
  } catch (err) {
    console.error("Geburtstags-Check-Fehler:", err);
    return { found: 0 };
  }
}

// ─── Weekly ranking system ────────────────────────────────────────────────────

let lastWeeklyRankingKey = ""; // "YYYY-WW" — prevents double-posting

/** Weighted score for a creator entry: streams=3pts, posts=2pts, stories=1pt */
function weekScore(e: { posts: number; stories: number; streams: number }): number {
  return e.posts * 2 + e.stories * 1 + e.streams * 3;
}

/** Returns the ISO week number (1–53) for any timestamp, using Berlin TZ. */
function isoWeekOf(ts: number): number {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ts + 1000)); // +1s to avoid midnight edge
  const day   = Number(parts.find((p) => p.type === "day")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const year  = Number(parts.find((p) => p.type === "year")!.value);
  const d = new Date(Date.UTC(year, month, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Returns "YYYY-WW" (ISO week) in Berlin TZ. */
function berlinWeekKey(): string {
  const now = new Date();
  const berlin = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const day = berlin.getDay();
  const monday = new Date(berlin);
  monday.setDate(berlin.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const startOfYear = new Date(monday.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((monday.getTime() - startOfYear.getTime()) / 86400000 + 1) / 7);
  return `${monday.getFullYear()}-${String(weekNo).padStart(2, "0")}`;
}

/** Returns current weekday in Berlin TZ: 0=Sun, 1=Mon … 6=Sat. */
function berlinWeekday(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", weekday: "short",
  }).formatToParts(new Date());
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[parts.find((p) => p.type === "weekday")!.value] ?? 1;
}

interface WeeklyCreatorEntry {
  streamer: string;
  roleMention: string | null;
  posts: number;
  stories: number;
  streams: number;
}

async function buildWeeklyRanking(guild: Guild, from: number, to: number): Promise<WeeklyCreatorEntry[]> {
  const keys: Array<{ key: keyof typeof config.channels; type: "posts" | "stories" | "streams" }> = [
    { key: "creator-posts", type: "posts" },
    { key: "creator-story", type: "stories" },
    { key: "creator-livestreams", type: "streams" },
  ];

  // Collect owner names to exclude from ranking
  const ownerNames = new Set<string>();
  try {
    const owner = await guild.fetchOwner();
    ownerNames.add(owner.displayName.toLowerCase());
    ownerNames.add(owner.user.username.toLowerCase());
    if (owner.user.globalName) ownerNames.add(owner.user.globalName.toLowerCase());
  } catch { /* ignore */ }

  const allResults = await Promise.all(
    keys.map(async ({ key, type }) => {
      const id = config.channels[key];
      if (!id) return { type, entries: [] as PingsyncEntry[] };
      try {
        const msgs = await fetchChannelMessages(guild, id, 100);
        const excludeNames = new Set([
          ...ownerNames,
          ...config.rankingExcludeNames,
        ]);
        const entries = msgs
          .map(parsePingsyncMsg)
          .filter((e): e is PingsyncEntry => e !== null)
          .filter((e) => e.timestamp >= from && e.timestamp < to)
          .filter((e) => {
            const name = e.streamer.toLowerCase();
            return !Array.from(excludeNames).some((n) => name.includes(n));
          });
        return { type, entries };
      } catch {
        return { type, entries: [] as PingsyncEntry[] };
      }
    }),
  );

  const byCreator = new Map<string, WeeklyCreatorEntry>();
  for (const { type, entries } of allResults) {
    for (const e of entries) {
      // Prefer roleMention as dedup key — it's the same across all channel types.
      // Fall back to normalised streamer name only if no role mention exists.
      const key = e.roleMention ?? e.streamer.toLowerCase().trim();
      const cur = byCreator.get(key) ?? {
        streamer: e.streamer, roleMention: e.roleMention, posts: 0, stories: 0, streams: 0,
      };
      if (!cur.roleMention && e.roleMention) cur.roleMention = e.roleMention;
      if (type === "posts") cur.posts++;
      else if (type === "stories") cur.stories++;
      else cur.streams++;
      byCreator.set(key, cur);
    }
  }

  return [...byCreator.values()]
    .sort((a, b) => weekScore(b) - weekScore(a));
}

// Checks Discord channel history to see if the bot already posted a message
// containing `keyword` today (since Berlin midnight). Used by all scheduled
// functions as a restart-safe duplicate guard in addition to the in-memory key.
async function botAlreadyPostedToday(channel: TextChannel, keyword: string): Promise<boolean> {
  try {
    const todayStart = berlinMidnightOf(0);
    const messages = await channel.messages.fetch({ limit: 50 });
    const botId = client.user?.id;
    return messages.some(
      (m) =>
        m.author.id === botId &&
        m.createdTimestamp >= todayStart &&
        m.content.includes(keyword),
    );
  } catch {
    return false;
  }
}

async function postWeeklyRanking(opts?: { force?: boolean }): Promise<{ posted: boolean }> {
  try {
    if (!opts?.force) {
      if (berlinWeekday() !== 1 || berlinHour() !== 9) return { posted: false };
      const wk = berlinWeekKey();
      if (lastWeeklyRankingKey === wk) return { posted: false };
      lastWeeklyRankingKey = wk;
    }

    const guild = client.guilds.cache.first();
    if (!guild) return { posted: false };

    const rankChanId = config.channels["wochenrangliste"];
    const hauptchatId = config.channels["hauptchat"];
    if (!rankChanId) return { posted: false };

    const rankChan = guild.channels.cache.get(rankChanId) as TextChannel | undefined;
    if (!rankChan?.isTextBased()) return { posted: false };
    if (!opts?.force && await botAlreadyPostedToday(rankChan, "**🏆 WR ")) return { posted: false };

    // Always Mon 00:00 → Sun 23:59 Berlin time (the week that just ended)
    const weekFrom = berlinMidnightOf(7); // last Monday 00:00
    const weekTo   = berlinMidnightOf(0); // this Monday 00:00 (exclusive)

    const ranking = await buildWeeklyRanking(guild, weekFrom, weekTo);
    if (ranking.length === 0) {
      await rankChan.send("📊 Diese Woche wurden noch keine Creator-Aktivitäten erkannt.");
      return { posted: true };
    }

    // WR number = ISO week number of the week that just ended (zero-padded)
    const wrNumber = String(isoWeekOf(weekFrom)).padStart(2, "0");

    // Display: "15.04.2026 – 21.04.2026"
    const fmt = (ts: number) => new Date(ts).toLocaleDateString("de-DE", {
      timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric",
    });
    const dateRange = `${fmt(weekFrom)} – ${fmt(weekTo - 1)}`;

    const medals = ["🥇", "🥈", "🥉"];

    const rankLines = ranking.slice(0, 15).map((e, i) => {
      const badge = medals[i] ?? `**${i + 1}.**`;
      const who = e.roleMention ? e.roleMention : `**${e.streamer}**`;
      const pts = weekScore(e);
      const detail = [
        e.posts > 0 ? `${e.posts}x 📹` : "",
        e.stories > 0 ? `${e.stories}x 📸` : "",
        e.streams > 0 ? `${e.streams}x 🔴` : "",
      ].filter(Boolean).join(" · ");
      return `${badge} ${who} — **${pts} Punkte** (${detail})`;
    });

    // Next period: this Monday 00:00 → next Sunday 23:59
    const nextFrom = weekTo;
    const nextTo   = weekTo + 7 * 24 * 60 * 60 * 1000;
    const nextWr   = String(wrNumber ? Number(wrNumber) + 1 : 1).padStart(2, "0");
    const nextPostDate = new Date(nextTo).toLocaleDateString("de-DE", {
      timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric",
    });

    const text = [
      `**🏆 WR ${wrNumber}** | ${dateRange}`,
      ``,
      rankLines.join("\n"),
      ``,
      `📸 1 Pkt  ·  📹 2 Pkt  ·  🔴 3 Pkt`,
      ``,
      `Glückwunsch an alle! Nächste Woche könnt ihr wieder angreifen 💪🔥`,
      ``,
      `─────────────────────────`,
      `📅 **Dieser Wertungszeitraum:** ${dateRange} | Mo. 00:00 Uhr – So. 23:59 Uhr`,
      `📅 **Nächster Wertungszeitraum (WR ${nextWr}):** ${fmt(nextFrom)} – ${fmt(nextTo - 1)} | Mo. 00:00 Uhr – So. 23:59 Uhr`,
      `⏰ **Einsendeschluss WR ${nextWr}:** Sonntag, ${fmt(nextTo - 1)} um 23:59 Uhr`,
      `🕘 **Veröffentlichung WR ${nextWr}:** Montag, ${nextPostDate} um 09:00 Uhr`,
    ].join("\n");

    await rankChan.send(text);

    // Teaser in Hauptchat
    if (hauptchatId) {
      const hauptchat = guild.channels.cache.get(hauptchatId) as TextChannel | undefined;
      if (hauptchat?.isTextBased()) {
        const top = ranking[0]!;
        const topWho = top.roleMention ?? `**${top.streamer}**`;
        await hauptchat.send(
          `🏆 **WR ${wrNumber}** (${dateRange}) ist online! Diese Woche führt ${topWho} das Ranking an 🔥 → <#${rankChanId}>`,
        );
      }
    }

    console.log(`📊 Weekly ranking posted for ${dateRange}`);
    return { posted: true };
  } catch (err) {
    console.error("Wochenrangliste-Fehler:", err);
    return { posted: false };
  }
}

// ─── Monday motivation message ────────────────────────────────────────────────

let lastMondayMotivationKey = "";

async function postMondayMotivation(opts?: { force?: boolean }): Promise<void> {
  try {
    if (!opts?.force) {
      if (berlinWeekday() !== 1 || berlinHour() !== 8) return;
      const today = new Date().toLocaleDateString("de-DE", {
        timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      });
      if (lastMondayMotivationKey === today) return;
      lastMondayMotivationKey = today;
    }

    const guild = client.guilds.cache.first();
    if (!guild) return;
    const hauptchatId = config.channels["hauptchat"];
    if (!hauptchatId) return;
    const hauptchat = guild.channels.cache.get(hauptchatId) as TextChannel | undefined;
    if (!hauptchat?.isTextBased()) return;
    if (!opts?.force && await botAlreadyPostedToday(hauptchat, "📹 Videos = 2 Pkt")) return;

    const creatorRole = guild.roles.cache.find((r) => r.name.toLowerCase().includes("creator"));
    const rolePing = creatorRole ? `<@&${creatorRole.id}>` : "@Creator";

    const messages = [
      [
        `Guten Morgen ${rolePing} ☀️💪`,
        ``,
        `Ein neuer Montag – eine neue Chance, euch zu beweisen!`,
        ``,
        `Diese Woche fängt die Wertung wieder bei null an. Wer diese Woche am meisten Gas gibt, steht am nächsten Montag ganz oben in der Rangliste 🏆`,
        ``,
        `📹 Videos = 2 Pkt  ·  📸 Storys = 1 Pkt  ·  🔴 Livestreams = 3 Pkt`,
        ``,
        `Let's go – macht diese Woche unvergesslich! 🚀🔥`,
      ],
      [
        `Guten Morgen ${rolePing} 🌅`,
        ``,
        `Montag bedeutet: frischer Start, neue Woche, neue Möglichkeiten! 💫`,
        ``,
        `Die Wochenrangliste läuft wieder — jeder Livestream, jedes Video, jede Story zählt. Zeigt TikTok was ihr drauf habt! 🎥`,
        ``,
        `📹 Videos = 2 Pkt  ·  📸 Storys = 1 Pkt  ·  🔴 Livestreams = 3 Pkt`,
        ``,
        `Wir drücken euch die Daumen — auf eine starke Woche! 💪🏆`,
      ],
      [
        `Hey ${rolePing} 🔥`,
        ``,
        `Die neue Woche ist da und damit startet auch die neue Wertung für die Wochenrangliste!`,
        ``,
        `Nutzt jeden Tag — streamt, postet, bleibt aktiv. Wer dran bleibt, wird belohnt 🏅`,
        ``,
        `📹 Videos = 2 Pkt  ·  📸 Storys = 1 Pkt  ·  🔴 Livestreams = 3 Pkt`,
        ``,
        `Macht diese Woche zu eurer besten! 🚀💥`,
      ],
    ];

    const text = messages[Math.floor(Math.random() * messages.length)]!.join("\n");
    await hauptchat.send(text);
    console.log("💪 Monday motivation posted.");
  } catch (err) {
    console.error("Montags-Motivation Fehler:", err);
  }
}

// ─── Sunday reminder message ──────────────────────────────────────────────────

let lastSundayReminderKey = "";

async function postSundayReminder(opts?: { force?: boolean }): Promise<void> {
  try {
    if (!opts?.force) {
      if (berlinWeekday() !== 0 || berlinHour() !== 18) return;
      const today = new Date().toLocaleDateString("de-DE", {
        timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      });
      if (lastSundayReminderKey === today) return;
      lastSundayReminderKey = today;
    }

    const guild = client.guilds.cache.first();
    if (!guild) return;
    const infoChanId = config.channels["information"];
    if (!infoChanId) return;
    const infoChan = guild.channels.cache.get(infoChanId) as TextChannel | undefined;
    if (!infoChan?.isTextBased()) return;
    if (!opts?.force && await botAlreadyPostedToday(infoChan, "Wochenrangliste — Letzter Tag")) return;

    const creatorRole = guild.roles.cache.find((r) => r.name.toLowerCase().includes("creator"));
    const rolePing = creatorRole ? `<@&${creatorRole.id}>` : "@Creator";

    const text = [
      `Hey ${rolePing} 👋`,
      ``,
      `Denkt daran, heute ist Sonntag:`,
      ``,
      `**🏆 Wochenrangliste — Letzter Tag!**`,
      `Ihr habt noch bis **23:59 Uhr** Zeit, Punkte zu sammeln:`,
      `📸 Story posten = 1 Punkt  ·  📹 Video posten = 2 Punkte  ·  🔴 Livestream starten = 3 Punkte`,
      `Morgen früh um **09:00 Uhr** wird die Rangliste veröffentlicht. Jeder Punkt kann noch den Unterschied machen! 💪`,
      ``,
      `**💰 TikTok Live-Belohnungen**`,
      `Eure gestaffelten Live-Belohnungen aus dem Stufensystem werden von TikTok zwischen **0 und 1 Uhr** ausgezahlt. Für einige kann es auch im Laufe des Montags passieren.`,
      `Schaut noch einmal nach, ob ihr mehr rausholen könnt – oft reicht ein weiterer Tag Livezeit, ein paar neue Follower oder kleine Anpassungen, um eure Einnahmen zu maximieren. 💰`,
      ``,
      `**🎁 Geschenkgalerie-Reset**`,
      `Die Geschenkgalerie wird wie jeden Sonntag zurückgesetzt. Ab **23:00 / 0:00 Uhr** können eure Zuschauer und Communities sich wieder eintragen. Nutzt das, um euer Liveziel direkt zu kombinieren. 🎁`,
    ].join("\n");

    await infoChan.send(text);
    console.log("🌙 Sunday reminder posted.");
  } catch (err) {
    console.error("Sonntags-Erinnerung Fehler:", err);
  }
}

// ─── Friday information message ───────────────────────────────────────────────

let lastFridayMsgKey = ""; // "YYYY-MM-DD" — prevents double-posting

async function postFridayMessage(opts?: { force?: boolean }): Promise<void> {
  try {
    if (!opts?.force) {
      // Only on Fridays at 12:00 Berlin time
      if (berlinWeekday() !== 5 || berlinHour() !== 12) return;
      const today = new Date().toLocaleDateString("de-DE", {
        timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      });
      if (lastFridayMsgKey === today) return;
      lastFridayMsgKey = today;
    }

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const infoChanId = config.channels["information"];
    if (!infoChanId) return;
    const infoChan = guild.channels.cache.get(infoChanId) as TextChannel | undefined;
    if (!infoChan?.isTextBased()) return;
    if (!opts?.force && await botAlreadyPostedToday(infoChan, "heute ist Freitag")) return;

    // Find @creator role by name
    const creatorRole = guild.roles.cache.find((r) =>
      r.name.toLowerCase().includes("creator"),
    );
    const rolePing = creatorRole ? `<@&${creatorRole.id}>` : "@Creator";

    const text = [
      `Hey 🙋 🌸 ${rolePing}`,
      ``,
      `heute ist Freitag – ich wünsche euch allen ein wunderschönes Wochenende! 🙌💫`,
      ``,
      `Kleiner Hinweis: Am Wochenende arbeitet TikTok nicht aktiv an Anträgen. Das bedeutet, wenn euer Account gesperrt wird, kann ich nicht garantieren, dass der Antrag auf Entsperrung sofort bearbeitet wird. In den meisten Fällen wird das erst ab Montag wieder geprüft.`,
      ``,
      `Daher meine Bitte an euch: Achtet am Wochenende besonders darauf, dass ihr euch nicht sperren lasst. 💡`,
      ``,
      `Ansonsten wünsche ich euch ein entspanntes Wochenende und viel Spaß beim Streamen! 🎥`,
      `Und wie immer: Wenn irgendetwas sein sollte – ich bin natürlich auch am Wochenende erreichbar, wie jeden Tag. 💬`,
    ].join("\n");

    await infoChan.send(text);
    console.log("📢 Friday message posted.");
  } catch (err) {
    console.error("Freitags-Nachricht Fehler:", err);
  }
}

// ─── KI-Assistent Vorstellung ─────────────────────────────────────────────────

// Markers from old versions that should trigger a replacement
const KI_INTRO_OLD_MARKERS = ["<!-- aura-ki-intro-v1 -->", "<!-- aura-ki-intro-v2 -->", "\u200b\u200c\u200b", "\u200b\u200c\u200c", "\u200b\u200b\u200c", "\u200c\u200b\u200c", "\u200c\u200c\u200b", "\u200c\u200c\u200c"];
// Stable identifier embedded invisibly at the end of the message
const KI_INTRO_STABLE_ID = "\u200b\u200b\u200b\u200c"; // zero-width chars, invisible in Discord

async function postKiAssistantIntro(): Promise<void> {
  try {
    const channelId = config.channels["ki-vorstellung"];
    if (!channelId) return;

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel?.isTextBased()) return;

    // Check pinned messages
    const pinnedResult = await channel.messages.fetchPins();
    const botPinned = pinnedResult.items.filter(
      (item: { message: { author: { id: string }; content: string } }) =>
        item.message.author.id === client.user?.id,
    );

    // Delete any old versioned messages
    for (const item of botPinned as { message: { author: { id: string }; content: string; unpin: () => Promise<void>; delete: () => Promise<void> } }[]) {
      if (KI_INTRO_OLD_MARKERS.some((m) => item.message.content.includes(m))) {
        await item.message.unpin();
        await item.message.delete();
        console.log("🗑️ Alte KI-Intro Nachricht gelöscht.");
      }
    }

    // Check if a clean (current) version already exists
    const cleanExists = botPinned.some(
      (item: { message: { author: { id: string }; content: string } }) =>
        !KI_INTRO_OLD_MARKERS.some((m) => item.message.content.includes(m)) &&
        item.message.content.includes(KI_INTRO_STABLE_ID),
    );
    if (cleanExists) {
      console.log("📌 KI-Assistent Vorstellung bereits vorhanden — überspringe.");
      return;
    }

    const kiChatId = config.channels["aura-ki-chat"];
    const kiChatMention = kiChatId ? `<#${kiChatId}>` : "`#🧠・aura-ki-chat`";
    const founderMention = config.founderDiscordId ? `<@${config.founderDiscordId}>` : "den Gründer";

    const intro = [
      `# 🧠 Hallo! Ich bin **Aura KI** — eure KI für diesen Server.`,
      ``,
      `Entwickelt von Grund auf für **Aura Influence Agentur** — ich kenne eure Kanäle, euren Creator-Alltag und lerne mit jeder Verbesserung dazu.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `## 💬 Wie ihr mich erreicht`,
      `Schreibt einen dieser Begriffe **irgendwo in eure Nachricht** — ich antworte automatisch:`,
      `> \`!aura\` oder \`!ki\``,
      `> \`@aura\` oder \`@ki\``,
      `> \`.aura\` oder \`.ki\``,
      `> Oder den Bot direkt in Discord markieren`,
      ``,
      `Ich antworte in **jedem Kanal**! Für längere Gespräche: ${kiChatMention}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `## 🤖 Was ich alles kann`,
      `📋 **Server & Agentur** — Regelwerk erklären, FAQ, wer ist neu, Updates zusammenfassen`,
      `🔴 **Livestream & Content** — wer ist live, wer hat gepostet, TikTok-Tipps & Wachstumsstrategien`,
      `✏️ **Texte & Ideen** — Captions schreiben, Hashtag-Vorschläge, Content-Ideen & Themenplanung`,
      `🏆 **Ranglisten & Events** — Wochen-/Monatsrangliste, Events & Kalender, Empfehlungsbonus`,
      `📊 **Deine Stats** — mit \`!aura meine stats\` siehst du Platz, Punkte & Aktivität der laufenden Woche`,
      `💪 **Creator-Coaching** — Motivation, Feedback zu Ideen, Tipps zum TikTok-Algorithmus & mehr`,
      `🌤️ **Allgemein** — Wetter, Datum & Uhrzeit, allgemeine Fragen & Gespräche aller Art`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `## 💡 Beispiele`,
      `\`\`\``,
      `!aura meine stats`,
      `!ki wer ist gerade live`,
      `!aura Hashtag-Ideen für Fitness TikToks`,
      `@ki Ich brauche Motivation, mein Wachstum stagniert`,
      `\`\`\``,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `## ⚠️ Wichtiger Hinweis`,
      `Ich bin eine **KI** — keine echte Person. Ich kann Fehler machen oder manchmal falsche Infos liefern.`,
      ``,
      `Fehler bemerkt? **Screenshot machen** und direkt an ${founderMention} melden — nur so kann ich verbessert und weiterentwickelt werden! 🙏`,
      ``,
      `> *Nicht zu verwechseln mit dem menschlichen Aura-Team — ich bin 24/7 für euch da.* ✨`,
      KI_INTRO_STABLE_ID,
    ].join("\n");

    const sent = await channel.send(intro);
    await sent.pin();
    console.log("✅ KI-Assistent Vorstellung gepostet und gepinnt.");
  } catch (err) {
    console.error("KI-Assistent Intro Fehler:", err);
  }
}

// ─── Daily Live Summary (20:00 Uhr Berlin) ───────────────────────────────────

let lastDailyLiveSummaryKey = "";

async function postDailyLiveSummary(opts?: { force?: boolean }): Promise<void> {
  try {
    if (!opts?.force) {
      if (berlinHour() !== 20) return;
      const today = berlinDateKey();
      if (lastDailyLiveSummaryKey === today) return;
      lastDailyLiveSummaryKey = today;
    }

    const guild = client.guilds.cache.first();
    if (!guild) return;

    const hauptchatId = config.channels["hauptchat"];
    const livestreamChannelId = config.channels["creator-livestreams"];
    if (!hauptchatId || !livestreamChannelId) return;

    const hauptchat = guild.channels.cache.get(hauptchatId) as TextChannel | undefined;
    if (!hauptchat?.isTextBased()) return;
    if (!opts?.force && await botAlreadyPostedToday(hauptchat, "Tages-Überblick")) return;

    // Fetch last 60 messages from livestream channel
    const allMsgs = await fetchChannelMessages(guild, livestreamChannelId, 60);
    const todayStart = berlinMidnightOf(0);

    const todayEntries = allMsgs
      .map(parsePingsyncMsg)
      .filter((e): e is PingsyncEntry => e !== null)
      .filter((e) => e.timestamp >= todayStart);

    const liveNow = todayEntries.filter((e) => !e.ended);
    const liveNowNames = new Set(liveNow.map((e) => e.streamer));

    // Deduplicate: who was live today (excluding currently live)
    const dedupedToday = deduplicateEntries(todayEntries);
    const wasLive = dedupedToday.filter((e) => !liveNowNames.has(e.streamer) || e.ended);

    const lines: string[] = [];
    lines.push(`📊 **Tages-Überblick — wer war heute live?**`);
    lines.push(``);

    if (liveNow.length > 0) {
      lines.push(`🔴 **Gerade live:**`);
      for (const e of liveNow) {
        const who = e.roleMention ?? `\`${e.streamer}\``;
        const title = e.title ? ` — „${e.title}"` : "";
        lines.push(`→ ${who}${title}`);
      }
      lines.push(``);
    }

    if (wasLive.length > 0) {
      lines.push(`✅ **Heute live gewesen:**`);
      for (const e of wasLive) {
        const who = e.roleMention ?? `\`${e.streamer}\``;
        const sessions = e.count > 1 ? ` (${e.count}x)` : "";
        lines.push(`→ ${who}${sessions}`);
      }
    }

    if (liveNow.length === 0 && wasLive.length === 0) {
      lines.push(`Heute war noch niemand live. 😴`);
      lines.push(``);
      lines.push(`Morgen ist eine neue Chance — jeder Livestream zählt! 💪`);
    } else {
      lines.push(``);
      const motivations = [
        `Stark — jeder Livestream zählt für die Wochenrangliste! 🏆`,
        `Weiter so! Regelmäßig live gehen ist der schnellste Weg zum Wachstum. 🚀`,
        `Gut gemacht! Wer dran bleibt, wird belohnt. 💪`,
        `Jeden Tag live — das ist der Unterschied zwischen gut und außergewöhnlich. 🔥`,
        `So macht man das! Konsistenz ist alles auf TikTok. ⭐`,
      ];
      lines.push(motivations[Math.floor(Math.random() * motivations.length)]!);
    }

    await hauptchat.send(lines.join("\n"));
    console.log("📊 Daily live summary posted.");
  } catch (err) {
    console.error("Tages-Live-Überblick Fehler:", err);
  }
}

// Check every 30 minutes — only actually posts during the 9:00 AM window
setInterval(() => { checkAndSendBirthdays().catch(() => undefined); }, 30 * 60 * 1000);
setInterval(() => { postWeeklyRanking().catch(() => undefined); }, 30 * 60 * 1000);
setInterval(() => { postFridayMessage().catch(() => undefined); }, 30 * 60 * 1000);
setInterval(() => { postMondayMotivation().catch(() => undefined); }, 30 * 60 * 1000);
setInterval(() => { postSundayReminder().catch(() => undefined); }, 30 * 60 * 1000);
setInterval(() => { postDailyLiveSummary().catch(() => undefined); }, 30 * 60 * 1000);

// Also run once when the bot becomes ready
client.once(Events.ClientReady, () => {
  console.log(`✅ Aura Bot eingeloggt als ${client.user?.tag}`);
  checkAndSendBirthdays().catch(() => undefined);
  postKiAssistantIntro().catch(() => undefined);
});

client.on(Events.Error, (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

// If Discord doesn't confirm the ready event within 90 seconds, force restart
// so the API server's auto-restart mechanism can try again.
const loginTimeout = setTimeout(() => {
  console.error("❌ Discord login timeout — kein Ready-Event nach 90s. Neustart...");
  process.exit(1);
}, 90_000);

console.log("🔑 Starte Discord Login...");
client.login(config.discordToken).catch((err) => {
  clearTimeout(loginTimeout);
  console.error("❌ Login fehlgeschlagen:", err);
  process.exit(1);
});

client.once(Events.ClientReady, () => {
  clearTimeout(loginTimeout);
});
