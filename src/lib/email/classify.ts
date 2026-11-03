import type { Classification } from "@/lib/types";

export function stripQuotedReply(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n");
  const cutMarkers = [
    /\nOn .{0,200} wrote:\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nFrom:\s.+\nSent:\s.+/i,
    /\n_{10,}\n/,
    /\n--\s*\n/,
  ];
  let text = normalized;
  for (const marker of cutMarkers) {
    const match = text.match(marker);
    if (match?.index && match.index > 0) text = text.slice(0, match.index);
  }
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .slice(0, 4000);
}

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  matched: string;
}

const RULES: {
  classification: Classification;
  confidence: number;
  patterns: RegExp[];
}[] = [
  {
    classification: "unsubscribe",
    confidence: 0.98,
    patterns: [
      /\bunsubscribe\b/i,
      /\bopt[\s-]?out\b/i,
      /\bremove (?:me|us) (?:from|off)\b/i,
      /\bstop (?:emailing|contacting|sending)\b/i,
      /\bdo not (?:contact|email|message)\b/i,
      /\bdon'?t (?:contact|email|message) (?:me|us)\b/i,
      /\bno more emails?\b/i,
    ],
  },
  {
    classification: "not_interested",
    confidence: 0.92,
    patterns: [
      /\bnot interested\b/i,
      /\bno thanks?\b/i,
      /\bnot a fit\b/i,
      /\bnot for us\b/i,
      /\bpass (?:for now|on this)\b/i,
      /\bwe(?:'re| are) (?:all )?(?:set|good)\b/i,
      /\bno need\b/i,
    ],
  },
  {
    classification: "pricing",
    confidence: 0.9,
    patterns: [
      /\bhow much\b/i,
      /\bpricing\b/i,
      /\bprice\b/i,
      /\bcost\b/i,
      /\bplans?\b/i,
      /\bbudget\b/i,
      /\bcommercial terms?\b/i,
    ],
  },
  {
    classification: "demo",
    confidence: 0.88,
    patterns: [
      /\bdemo\b/i,
      /\bshow me\b/i,
      /\bwalk(?: me)? through\b/i,
      /\b(?:book|schedule|arrange) (?:a )?(?:call|meeting|time)\b/i,
      /\bcalendar\b/i,
      /\bavailable (?:for|on) (?:a )?(?:call|chat)\b/i,
    ],
  },
  {
    classification: "technical",
    confidence: 0.82,
    patterns: [
      /\bapi\b/i,
      /\bwebhooks?\b/i,
      /\bsmtp\b/i,
      /\bimap\b/i,
      /\btechnical\b/i,
      /\binfrastructure\b/i,
      /\bmigration\b/i,
      /\bdata (?:export|import)\b/i,
      /\bbug\b/i,
      /\berror\b/i,
    ],
  },
  {
    classification: "features",
    confidence: 0.8,
    patterns: [
      /\bfeatures?\b/i,
      /\bcan (?:it|you) (?:handle|support|do)\b/i,
      /\bdoes it (?:support|integrate|handle)\b/i,
      /\bintegrations?\b/i,
      /\bwhite[\s-]?label\b/i,
    ],
  },
  {
    classification: "interested",
    confidence: 0.85,
    patterns: [
      /\binterested\b/i,
      /\btell me more\b/i,
      /\bsounds (?:good|interesting)\b/i,
      /\bkeen to (?:learn|hear|see)\b/i,
      /\bworth a (?:chat|conversation|call)\b/i,
      /\byes\b/i,
      /\blet'?s talk\b/i,
    ],
  },
];

export function classifyReply(rawBody: string): ClassificationResult {
  const body = stripQuotedReply(rawBody).replace(/\s+/g, " ").trim();
  if (!body) {
    return { classification: "other", confidence: 0.3, matched: "empty" };
  }
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = body.match(pattern);
      if (match) {
        return {
          classification: rule.classification,
          confidence: rule.confidence,
          matched: match[0],
        };
      }
    }
  }
  return { classification: "other", confidence: 0.4, matched: "no rule" };
}
