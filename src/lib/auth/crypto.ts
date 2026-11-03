import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "enc:v1";

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not configured. Add a 32-byte base64 key before storing email credentials.",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("APP_ENCRYPTION_KEY must be valid base64.");
  }
  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}).`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== VERSION) {
    throw new Error("Stored email credential is not in a supported format.");
  }
  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const ciphertext = Buffer.from(parts[4], "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

export function stableFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
