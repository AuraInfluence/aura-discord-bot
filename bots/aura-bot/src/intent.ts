import { config, type ChannelKey } from "./config.js";

export type Intent =
  | { kind: "channel-summary"; channel: ChannelKey; channelId: string }
  | { kind: "newest-member" }
  | { kind: "latest-event" }
  | { kind: "who-is-live" }
  | { kind: "whats-new"; timeFilter: "today" | "yesterday" | "week" }
  | { kind: "weather"; location: string }
  | { kind: "datetime" }
  | { kind: "my-stats" }
  | { kind: "owner-stats" }
  | { kind: "free-question" };

interface Keyword {
  channel: ChannelKey;
  patterns: RegExp[];
}

// Order matters — more specific patterns first.
const CHANNEL_KEYWORDS: Keyword[] = [
  { channel: "regelwerk", patterns: [/regelwerk/i, /\bregeln\b/i] },
  { channel: "richtlinien-faq", patterns: [/richtlinien[\s-]*faq/i, /richtlinien/i] },
  { channel: "agentur-faq", patterns: [/agentur[\s-]*faq/i] },
  { channel: "agentur-info", patterns: [/agentur[\s-]*info/i] },
  {
    channel: "events-rangliste",
    patterns: [
      /events?[\s-]*rangliste/i,
      /event.*gewonnen/i,
      /gewonnen.*event/i,
      /event.*sieger/i,
      /sieger.*event/i,
      /event.*gewinner/i,
      /gewinner.*event/i,
      /wer.*hat.*event/i,
      /event.*wer.*hat/i,
    ],
  },
  { channel: "agentur-events", patterns: [/agentur[\s-]*events?/i] },
  { channel: "tiktok-events", patterns: [/tik[\s-]*tok[\s-]*events?/i, /tiktok/i] },
  { channel: "event-kalender", patterns: [/event[\s-]*kalender/i, /kalender/i] },
  { channel: "schaufenster-diamanten", patterns: [/schaufenster[\s-]*diamanten/i, /diamanten/i] },
  { channel: "schaufenster-livezeit", patterns: [/schaufenster[\s-]*livezeit/i, /livezeit/i] },
  {
    channel: "monatsrangliste",
    patterns: [
      /monats?rangliste/i,
      /\brangliste\b/i,
      /\bplatz\s*\d+/i,
      /platz\s*eins/i,
      /platz\s*zwei/i,
      /platz\s*drei/i,
      /\bnummer\s*1\b/i,
      /\bnr\.?\s*1\b/i,
      /wer.*?f(ü|ue)hrt/i,
      /wer.*?erster/i,
      /wer.*?(hat.*?gewonnen|gewonnen)/i,
      /\bleaderboard\b/i,
      /top\s*\d+/i,
      /wer.*?aktuell\s*(da|vorne|platz)/i,
    ],
  },
  { channel: "empfehlungsbonus", patterns: [/empfehlungs?bonus/i, /empfehlung/i] },
  { channel: "tipps-und-tricks", patterns: [/tipps?[\s-]*und[\s-]*tricks/i, /\btipps?\b/i, /\btricks\b/i] },
  { channel: "live-manager", patterns: [/live[\s-]*manage/i] },
  { channel: "umfragen", patterns: [/umfragen?/i, /poll/i] },
  { channel: "updates", patterns: [/\bupdates?\b/i] },
  { channel: "information", patterns: [/informationen?/i, /\binfos?\b/i] },
  { channel: "neu-dazugekommen", patterns: [/neu[\s-]*dazugekommen/i] },
  {
    channel: "creator-livestreams",
    patterns: [
      /creator[\s-]*livestreams?/i,
      /\blivestreams?\b/i,
      /creator[\s-]*streams?/i,
      /\bstreams?\b/i,
    ],
  },
  { channel: "creator-story", patterns: [/creator[\s-]*story/i, /\bstory\b/i, /wer.*?story/i, /story.*?gepostet/i] },
  {
    channel: "creator-posts",
    patterns: [
      /creator[\s-]*posts?/i,
      /neue?\s*posts?/i,
      /wer.*?video/i,
      /video.*?gepostet/i,
      /neues?\s*video/i,
      /wer hat.*?gepostet/i,
      /was.*?video/i,
      /\bvideos?\b/i,
    ],
  },
  { channel: "vorstellungsrunde", patterns: [/vorstellungsrunde/i, /vorstellung/i] },
  { channel: "vorschlaege", patterns: [/vorschl(ae|ä)ge/i, /vorschlag/i] },
  { channel: "feedback", patterns: [/feedback/i] },
  { channel: "geburtstag", patterns: [/geburtstag/i] },
  { channel: "gaming-chat", patterns: [/gaming[\s-]*chat/i, /\bgaming\b/i] },
  { channel: "social-media", patterns: [/social[\s-]*media/i] },
  { channel: "hauptchat", patterns: [/hauptchat/i] },
  // generic fallbacks last
  { channel: "agentur-events", patterns: [/kampagnen?/i] },
];

const MY_STATS_PATTERNS = [
  /meine?\s+stats?/i,
  /mei\w*\s+stats?/i,         // typos: meienee, meiene, meins, etc.
  /meine?\s+punkte/i,
  /mei\w*\s+punkte/i,
  /wie\s+viele?\s+punkte\s+(hab(e|t)?|hast)\s+ich/i,
  /mein\s+ranking/i,
  /mein(en?)?\s+(aktuell(en?)?\s+)?stand/i,
  /meine?\s+woche/i,
  /wie\s+steh(e|t)\s+ich/i,
  /wie\s+l(ä|ae)uf(t|ts)\s+(es\s+)?bei\s+mir/i,
  /bin\s+ich\s+(in\s+der\s+)?rangliste/i,
  /meine?\s+aktivit(ä|ae)t/i,
  /mei\w*\s+aktivit/i,
];

const OWNER_STATS_PATTERNS = [
  /alle\s+stats?/i,
  /gesamtstatistik/i,
  /creator[\s-]*stats?\b/i,
  /creator[\s-]*(ge(samt|))?[üu]bersicht/i,
  /alle\s+creator/i,
  /wer\s+ist\s+(am\s+)?(aktivsten?|meisten?\s+aktiv)/i,
  /server[\s-]*statistik/i,
  /aktivit(ä|ae)ts?[\s-]*[üu]bersicht/i,
  /gesamt[üu]bersicht/i,
  /live[\s-]*statistik/i,
  /video[\s-]*statistik/i,
  /admin[\s-]*stats?/i,
];

const NEW_MEMBER_PATTERNS = [
  /wer ist neu/i,
  /neue?\s*mitglied/i,
  /neu(este[nr]?)?\s*(user|member)/i,
  /letzte[nr]?\s*(beigetreten|gejoint)/i,
  /dazugekommen/i,
];

const LATEST_EVENT_PATTERNS = [
  /letzte[ns]?\s*event/i,
  /aktuelle[ns]?\s*event/i,
  /neueste[ns]?\s*event/i,
  /n(ä|ae)chste[ns]?\s*event/i,
  /was.*?event/i,
  /gibt.*?event/i,
  /welche[ns]?\s*event/i,
];

const LIVE_PATTERNS = [
  /wer.*?live/i,
  /live.*?wer/i,
  /wer.*?streamt/i,
  /wer.*?gestreamt/i,
  /wer.*?streaming/i,
  /wer\s+hat\s+gestreamt/i,
  /\bgestern.*?live/i,
  /\blive.*?gestern/i,
  /aktuell.*?live/i,
  /live.*?aktuell/i,
  /zuletzt.*?live/i,
  /live.*?zuletzt/i,
  /wer.*?stream/i,
];

const WHATS_NEW_PATTERNS = [
  /was gibt es neues?/i,
  /was ist neu\b/i,
  /was ist passiert/i,
  /was hat sich (getan|ge(ä|ae)ndert)/i,
  /was.*?alles.*?neu/i,
  /neues? auf dem server/i,
  /was wurde.*?gepostet/i,
  /was ist (aktuell |gerade )?los/i,
  /\büberblick\b/i,
  /zeig.*?alles neues?/i,
  /server (news|neues)/i,
  // Summary / recap requests
  /\bzusammenfassung\b/i,
  /\brecap\b/i,
  /\bfasst? (mir |mal )?(alles |den server |heute |den tag )?zusammen/i,
  /was (ist |war )?(alles |so )?(heute|gestern|diese woche|letzte woche)/i,
  /was (ist|war|ist so) (heute|gestern) (passiert|los|gewesen|abgelaufen)/i,
  /gib mir (einen? )?(überblick|zusammenfassung|update|recap)/i,
  /zeig mir (einen? )?(überblick|zusammenfassung|update|recap)/i,
  /server.{0,20}(zusammenfassung|überblick|update|recap)/i,
  /discord.{0,20}(zusammenfassung|überblick|update|recap)/i,
];

export function detectIntent(text: string): Intent {
  const cleaned = text
    .replace(/!?aura/i, "")
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (NEW_MEMBER_PATTERNS.some((p) => p.test(cleaned))) {
    return { kind: "newest-member" };
  }

  // Live check — exclude "livemanager" queries which aren't about streams.
  // Use "manage" stem to handle typos like "livemanageer", "livemanagerr" etc.
  const isLiveManagerQuery = /live[\s-]?manage/i.test(cleaned);
  if (!isLiveManagerQuery && LIVE_PATTERNS.some((p) => p.test(cleaned))) {
    return { kind: "who-is-live" };
  }

  if (WHATS_NEW_PATTERNS.some((p) => p.test(cleaned))) {
    // Detect time filter from the message
    let timeFilter: "today" | "yesterday" | "week" = "week";
    if (/\bgestern\b/i.test(cleaned)) {
      timeFilter = "yesterday";
    } else if (/\bheute\b|\bheute?\s+(alles|nachrichten|gepostet|passiert|los)\b|\b(neueste|neue)\b/i.test(cleaned)) {
      timeFilter = "today";
    }
    return { kind: "whats-new", timeFilter };
  }

  // "letztes event" always triggers latest-event (channel is resolved in handler)
  if (LATEST_EVENT_PATTERNS.some((p) => p.test(cleaned))) {
    return { kind: "latest-event" };
  }

  for (const { channel, patterns } of CHANNEL_KEYWORDS) {
    if (patterns.some((p) => p.test(cleaned))) {
      const id = config.channels[channel];
      if (id) {
        return { kind: "channel-summary", channel, channelId: id };
      }
    }
  }

  if (MY_STATS_PATTERNS.some((p) => p.test(cleaned))) {
    return { kind: "my-stats" };
  }

  if (OWNER_STATS_PATTERNS.some((p) => p.test(cleaned))) {
    return { kind: "owner-stats" };
  }

  // Date / time queries
  if (/\b(uhrzeit|wie sp[äa]t|wieviel uhr|wie viel uhr|aktuelle(r|s)?\s*(uhrzeit|tag|datum)|welche(r|s)?\s*(tag|datum|wochentag)|datum|heute|wochentag)\b/i.test(cleaned)) {
    return { kind: "datetime" };
  }

  // Weather queries — extract location after "in" or at end
  const weatherMatch = cleaned.match(
    /wetter(?:vorhersage)?(?:\s+(?:in|f[üu]r|von))?\s+([a-zäöüßÄÖÜ\s\-]+?)(?:\s+(?:heute|morgen|jetzt|aktuell|gerade))?\s*$/i,
  ) ?? cleaned.match(/(?:wie\s+ist\s+(?:das\s+)?wetter|wetter|weather)(?:\s+(?:in|f[üu]r|von))?\s+([a-zäöüßÄÖÜ\s\-]+)/i);

  if (weatherMatch?.[1]) {
    return { kind: "weather", location: weatherMatch[1].trim() };
  }
  if (/\b(wetter|weather|regen|sonne|schnee|temperatur|grad|warm|kalt)\b/i.test(cleaned)) {
    return { kind: "weather", location: "" };
  }

  return { kind: "free-question" };
}
