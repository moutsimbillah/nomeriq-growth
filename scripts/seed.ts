import "dotenv/config";
import { config } from "dotenv";
import { getDb, closeDb } from "../src/lib/db/client";
import { hashPassword } from "../src/lib/auth/password";
import { ensureWorkspaceDefaults, getWorkspaceSettings, updateWorkspaceSettings } from "../src/lib/services/settings";
import { createResearchJob, getResearchJob } from "../src/lib/services/research";
import { saveProspect, listProspects } from "../src/lib/services/prospects";
import { generateDraftForProspect } from "../src/lib/services/drafts";
import { createEmailAccount, listEmailAccounts } from "../src/lib/email/accounts";

config({ path: ".env.local" });

const OBSERVED_AT = "2026-11-03T00:00:00.000Z";

async function main() {
  if (!process.env.APP_ENCRYPTION_KEY) {
    throw new Error("APP_ENCRYPTION_KEY is required to seed encrypted email credentials.");
  }
  const db = await getDb();
  await ensureWorkspaceDefaults();

  const email = (process.env.ADMIN_EMAIL || "founder@nomeriq.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("ADMIN_PASSWORD must be set (at least 10 characters).");
  }
  const name = process.env.ADMIN_NAME || "Founder";

  const existingUser = await db.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE normalized_email = $1",
    [email],
  );
  let userId = existingUser.rows[0]?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'founder')`,
      [userId, email, email, name, hashPassword(password)],
    );
    console.log(`Created founder account: ${email}`);
  } else {
    console.log(`Founder account already exists: ${email}`);
  }

  await updateWorkspaceSettings(
    {
      legalBusinessName: "Nomeriq",
      postalAddress: "",
      senderSignature: `${name}\nNomeriq`,
      footerNote:
        "You are receiving this because your business publishes trading signals and we thought Nomeriq might be relevant. Reply “stop” and I will not contact you again.",
      followUpMax: 2,
      followUpDelay1Days: 4,
      followUpDelay2Days: 7,
      syncStaleHours: 24,
      timezone: "Asia/Karachi",
    },
    userId,
  );

  const accounts = await listEmailAccounts();
  let account = accounts.find((item) => item.provider === "sandbox");
  if (!account) {
    account = await createEmailAccount(
      {
        name: "Sandbox test mailbox",
        provider: "sandbox",
        emailAddress: "sandbox@nomeriq.test",
        fromName: `${name} (Sandbox)`,
        dailySendLimit: 100,
        minIntervalSeconds: 5,
        isDefault: true,
      },
      userId,
    );
    console.log("Created sandbox test mailbox (no SMTP or IMAP connection).");
  }

  let job = (await db.query<{ id: string }>(
    "SELECT id FROM research_jobs WHERE name = $1 LIMIT 1",
    ["Batch 01 — 100 commercial signal providers"],
  )).rows[0];
  if (!job) {
    const createdJob = await createResearchJob({
      name: "Batch 01 — 100 commercial signal providers",
      targetCount: 100,
      categories: ["forex", "metals", "crypto", "indices", "commodities"],
      regions: "Worldwide — prioritise non-English and under-researched markets",
      requirements:
        "Only commercial trading-signal providers with a verified paid signal service and a publicly published business email. Exclude brokers, education-only, stocks/options-only, indicators, bots, copy-trading-only, news sites and general communities. One record per business; return existing records on duplicates.",
      notes:
        "Seeded vertical slice contains two genuine providers. Continue through ChatGPT/Claude MCP or the Agent API; progress persists here.",
      userId,
    });
    job = { id: createdJob.id };
    console.log(`Created research job: ${createdJob.id}`);
  } else {
    console.log(`Research job already exists: ${job.id}`);
  }

  const existingProspects = await listProspects({ jobId: job.id, limit: 10 });
  const byDomain = new Map(existingProspects.map((p) => [p.domainKey, p]));

  if (!byDomain.has("fxpremiere.com")) {
    const saved = await saveProspect({
      businessName: "FXPremiere",
      websiteUrl: "https://www.fxpremiere.com/",
      country: "Seychelles",
      categories: ["forex", "metals", "crypto", "indices"],
      signalDescription:
        "Sells monthly Telegram signal subscriptions for gold (XAU/USD), forex, crypto and indices. Each signal states direction, entry, stop-loss and take-profit levels; public plans range from $49 to $199.99 per month.",
      pricingDetails:
        "Gold XAU/USD $199.99/month; Forex $49/month; Crypto $49.99/month; Indices $99/month. Monthly subscriptions via Whop. The site describes an intermediary signal-aggregation model and states that sales are non-refundable.",
      evidenceSummary:
        "The official homepage publishes paid Telegram signal packages and sample signal format. The official terms identify FXPremiere as a signal intermediary operated by Nobility Group, Seychelles. The public footer publishes the contact email. No broker account is required to buy signals.",
      researchNotes:
        "Genuine commercial signal seller, not a broker. The official terms disclose aggregation from third-party signal sources. No Instagram found. Public follower counts were not independently verified and are left Unknown.",
      email: "daniel@fxpremiere.com",
      emailSourceUrl: "https://www.fxpremiere.com/terms-of-service/",
      emailSourceType: "official_website",
      youtubeUrl: "https://www.youtube.com/@ForexSignalsSMS",
      xUrl: "https://x.com/ForexSignalsSMS",
      telegramUrl: "https://t.me/forexsignalstrialgroup",
      otherSocials: [
        { label: "TikTok", url: "https://www.tiktok.com/@fxpremiere.com" },
      ],
      sources: [
        {
          url: "https://www.fxpremiere.com/",
          label: "Official homepage — paid signal plans and signal format",
          observedAt: OBSERVED_AT,
          notes:
            "Lists Gold, Forex, Crypto and Indices Telegram subscriptions with monthly prices and take-profit levels.",
        },
        {
          url: "https://www.fxpremiere.com/terms-of-service/",
          label: "Terms and official contact footer",
          observedAt: OBSERVED_AT,
          notes:
            "Confirms intermediary signal model, Nobility Group (Seychelles), and publishes daniel@fxpremiere.com / support@fxpremiere.com.",
        },
        {
          url: "https://www.fxpremiere.com/gold-signals/",
          label: "Gold XAU/USD signal product page",
          observedAt: OBSERVED_AT,
        },
      ],
      aliases: ["FXPremiere.com", "FxPremiere Group"],
      researchJobId: job.id,
      qualificationStatus: "verified",
      actorType: "seed",
      actorUserId: userId,
    });
    if (saved.created) {
      console.log(`Seeded verified prospect: ${saved.prospect.businessName}`);
    }
  }

  if (!byDomain.has("p4provider.com")) {
    const saved = await saveProspect({
      businessName: "P4 Provider",
      websiteUrl: "https://p4provider.com/",
      country: "Pakistan",
      categories: ["forex", "crypto"],
      signalDescription:
        "Sells separate VIP crypto and VIP forex signal plans alongside a paid trading mentorship. The public pricing page lists one month of signal access at $10 (Rs. 3,000), with six-month, annual and lifetime options; the FAQ says signals include reasoning and a published track record.",
      pricingDetails:
        "VIP Crypto Signals and VIP Forex Signals: $10/month (Rs. 3,000), $55/6 months, $110/year, $1,000 lifetime. Mentorship is separate: $150 online / $200 physical. Prices observed on the official pricing page.",
      evidenceSummary:
        "Official pricing page lists VIP Crypto and VIP Forex signal access as paid products. The official FAQ states the team provides signals with full reasoning and a published track record. The official contact page publishes contact@p4provider.com. The business also sells mentorship, but the paid signal service is separately verified.",
      researchNotes:
        "Qualifies because the paid signal service is explicit and separate from mentorship. Offices in Faisalabad and Lahore. Do not treat the mentorship as signal evidence. Follower counts were not captured and remain Unknown.",
      email: "contact@p4provider.com",
      emailSourceUrl: "https://p4provider.com/contact",
      emailSourceType: "official_website",
      instagramUrl: "https://www.instagram.com/instap4provider",
      youtubeUrl: "https://www.youtube.com/@p4provider",
      xUrl: "https://x.com/p4provider",
      otherSocials: [
        { label: "Facebook", url: "https://www.facebook.com/p4provider" },
        { label: "TikTok", url: "https://www.tiktok.com/@p4provider" },
      ],
      sources: [
        {
          url: "https://p4provider.com/pricing",
          label: "Official pricing — VIP signal plans",
          observedAt: OBSERVED_AT,
          notes:
            "Separate VIP Crypto and VIP Forex signal plans with monthly, six-month, annual and lifetime pricing.",
        },
        {
          url: "https://p4provider.com/contact",
          label: "Official contact page — published business email",
          observedAt: OBSERVED_AT,
          notes:
            "Publishes contact@p4provider.com and Pakistan office locations.",
        },
        {
          url: "https://p4provider.com/help/troubleshooting-and-support/contacting-support",
          label: "Official support article — contact email and hours",
          observedAt: OBSERVED_AT,
        },
      ],
      aliases: ["P4Provider", "P4 Provider Trading"],
      researchJobId: job.id,
      qualificationStatus: "verified",
      actorType: "seed",
      actorUserId: userId,
    });
    if (saved.created) {
      console.log(`Seeded verified prospect: ${saved.prospect.businessName}`);
    }
  }

  // Demonstrate the duplicate path through the real database-backed service.
  const duplicate = await saveProspect({
    businessName: "FXPremiere.com Signals",
    websiteUrl: "https://www.fxpremiere.com/gold-signals/",
    categories: ["metals"],
    signalDescription: "Duplicate test candidate for the same provider.",
    email: "daniel@fxpremiere.com",
    emailSourceUrl: "https://www.fxpremiere.com/terms-of-service/",
    sources: [
      {
        url: "https://www.fxpremiere.com/gold-signals/",
        label: "Duplicate test",
        observedAt: OBSERVED_AT,
      },
    ],
    researchJobId: job.id,
    qualificationStatus: "verified",
    actorType: "seed",
    actorUserId: userId,
  });
  if (duplicate.duplicate) {
    console.log(`Duplicate protection demonstrated: ${duplicate.matchedOn?.join(", ")}`);
  }

  const all = await listProspects({ jobId: job.id, limit: 10 });
  for (const prospect of all) {
    await generateDraftForProspect({
      prospectId: prospect.id,
      actorType: "seed",
      actorUserId: userId,
    });
  }

  const progress = await getResearchJob(job.id);
  console.log("\nSeed complete.");
  console.log(`Sign in: ${email}`);
  console.log(`Password: ${password}`);
  console.log(
    `Research progress: ${progress?.verifiedCount}/${progress?.targetCount} verified, ${progress?.draftCount} drafts, ${progress?.duplicatesRejected} duplicate rejected.`,
  );
  console.log("No email has been sent. All outbound activity is sandbox-only.");
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
