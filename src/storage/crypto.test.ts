import { describe, expect, test } from "bun:test";
import { createPkceChallenge, createPkceVerifier, decrypt, encrypt, parseEncryptionKey } from "./crypto";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("storage crypto", () => {
  test("encrypts and decrypts values with AES-256-GCM", async () => {
    const encrypted = await encrypt("secret value", key);
    expect(encrypted).not.toContain("secret value");
    expect(await decrypt(encrypted, key)).toBe("secret value");
  });

  test("rejects tampered ciphertext", async () => {
    const encrypted = await encrypt("secret value", key);
    const [version, iv, ciphertext] = encrypted.split(".");
    const replacement = ciphertext.at(-1) === "A" ? "B" : "A";
    await expect(decrypt(`${version}.${iv}.${ciphertext.slice(0, -1)}${replacement}`, key)).rejects.toThrow("Unable to decrypt value");
  });

  test("validates encryption keys only when crypto is used", () => {
    expect(() => parseEncryptionKey("")).toThrow("required");
    expect(() => parseEncryptionKey("invalid")).toThrow("32-byte");
  });

  test("creates PKCE verifier and S256 challenge", async () => {
    const verifier = createPkceVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await createPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
