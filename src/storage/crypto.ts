const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;

export class EncryptionKeyConfigurationError extends Error {
  readonly code = "APP_ENCRYPTION_KEY_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyConfigurationError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytesToBase64(bytes) === value ? bytes : undefined;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Random token length must be positive");
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Buffer.from(digest).toString("hex");
}

export function parseEncryptionKey(value: string | undefined = Bun.env.APP_ENCRYPTION_KEY): Uint8Array {
  if (!value) throw new EncryptionKeyConfigurationError("APP_ENCRYPTION_KEY is required for encryption operations");

  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : base64ToBytes(value);

  if (!key || key.length !== AES_256_KEY_BYTES) {
    throw new EncryptionKeyConfigurationError("APP_ENCRYPTION_KEY must be a base64 or hexadecimal 32-byte key");
  }
  return key;
}

async function importEncryptionKey(value?: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(parseEncryptionKey(value)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(plaintext: string, encryptionKey?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importEncryptionKey(encryptionKey), textEncoder.encode(plaintext));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decrypt(encrypted: string, encryptionKey?: string): Promise<string> {
  const [version, encodedIv, encodedCiphertext, extra] = encrypted.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) throw new Error("Invalid encrypted value");

  const iv = base64ToBytes(encodedIv.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encodedIv.length / 4) * 4, "="));
  const ciphertext = base64ToBytes(encodedCiphertext.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encodedCiphertext.length / 4) * 4, "="));
  if (!iv || iv.length !== AES_GCM_IV_BYTES) throw new Error("Invalid encrypted value");
  if (!ciphertext) throw new Error("Unable to decrypt value");

  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, await importEncryptionKey(encryptionKey), toArrayBuffer(ciphertext));
    return textDecoder.decode(plaintext);
  } catch {
    throw new Error("Unable to decrypt value");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function createPkceVerifier(): string {
  return randomToken(32);
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier));
  return base64Url(new Uint8Array(digest));
}
