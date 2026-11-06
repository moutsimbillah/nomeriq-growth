/** Names are evidence, never a transformation of an email address. */
export interface ReplyContactTurn {
  direction: "inbound" | "outbound";
  fromName?: string | null;
  fromEmail: string;
  bodyText?: string;
}

function cleanName(value: string | null | undefined, emails: string[]): string | null {
  const name = value?.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]*$/u.test(name)) return null;
  const compact = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  // Display-name headers can themselves be copied from an address by an importer. Refuse those too.
  if (name === name.toLocaleLowerCase() && emails.some(email => compact(email.split("@")[0] ?? "") === compact(name))) return null;
  if (/^(contact|info|support|admin|sales|team|service|customer service|unknown)$/i.test(name)) return null;
  return name;
}

/** Messages arrive newest first. A signed name in a message is evidence; arbitrary prose is not. */
export function replyContactName(turns: ReplyContactTurn[], recordedName?: string | null): string | null {
  const incoming = turns.filter(turn => turn.direction === "inbound");
  const emails = incoming.map(turn => turn.fromEmail);
  const recorded = cleanName(recordedName, emails);
  if (recorded) return recorded;
  for (const turn of incoming) {
    const display = cleanName(turn.fromName, emails);
    if (display) return display;
    const signed = turn.bodyText?.match(/(?:^|\n)(?:best(?: regards)?|kind regards|regards|thanks|merci|cordialement|saludos|atenciosamente)[,!\s]*\n([^\n]+)(?:\n|$)/i);
    const name = cleanName(signed?.[1], emails);
    if (name) return name;
  }
  return null;
}

/** Translated forms for common reply languages; unsupported languages get a neutral business line. */
export function replyGreeting(name: string | null, business: string, language?: string | null): string {
  const team = (business ?? "").replace(/[\r\n<>]/g, " ").trim() || "your";
  const lang = (language ?? "en").toLowerCase().split("-")[0];
  const who = name?.trim().split(/\s+/)[0];
  switch (lang) {
    case "fr": return `Bonjour ${who ?? `l’équipe ${team}`},`;
    case "es": return `Hola ${who ?? `equipo de ${team}`},`;
    case "pt": return `Olá ${who ?? `equipe ${team}`},`;
    case "de": return `Hallo ${who ?? `${team}-Team`},`;
    case "it": return `Ciao ${who ?? `team ${team}`},`;
    case "ar": return `مرحباً ${who ?? `فريق ${team}`}،`;
    case "ur": return `سلام ${who ?? `${team} ٹیم`}،`;
    case "hi": return `नमस्ते ${who ?? `${team} टीम`},`;
    case "ru": return `Здравствуйте, ${who ?? `команда ${team}`}!`;
    case "zh": return `${who ?? `${team} 团队`}，您好！`;
    case "ja": return `${who ?? `${team} チーム`}様、こんにちは。`;
    case "ko": return `${who ?? `${team} 팀`}님, 안녕하세요.`;
    case "tr": return `Merhaba ${who ?? `${team} ekibi`},`;
    case "id": return `Halo ${who ?? `tim ${team}`},`;
    case "en": return `Hi ${who ?? `${team} team`},`;
    default: return `${who ?? team},`;
  }
}

/** Replace the model's greeting rather than trusting it not to invent a name from an address. */
export function withReplyGreeting(body: string, greeting: string): string {
  const lines = body.trim().split(/\r?\n/);
  if (/^(?:hi\b|hello\b|hey\b|dear\b|bonjour\b|salut\b|hola\b|olá\b|hallo\b|ciao\b|merhaba\b|halo\b|здравствуйте\b|مرحب|سلام|नमस्ते|.*(?:您好|こんにちは|안녕하세요))/iu.test(lines[0] ?? "")) {
    const first = lines.shift() ?? "";
    // A model may put the greeting and answer on one line. Keep everything after the greeting's
    // comma/colon rather than discarding the entire answer (and its confirmation sentences).
    const separator = first.search(/[,،，:：!！]/u);
    const rest = separator >= 0 ? first.slice(separator + 1).trim() : "";
    if (rest) lines.unshift(rest);
    while (!lines[0]?.trim() && lines.length) lines.shift();
  }
  return `${greeting}\n\n${lines.join("\n").trim()}`;
}
