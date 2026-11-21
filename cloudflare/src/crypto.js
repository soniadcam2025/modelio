// Credential encryption: AES-256-GCM with a key that lives only in the Worker secret CREDENTIALS_KEY
// (32 random bytes, base64). Supabase stores ciphertext; without the Worker key it is useless.
// Each ciphertext is bound to its record ("bot:<telegram bot id>", "integration:cloudinary") as additional data,
// so a ciphertext copied onto another record fails to decrypt.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keys = new Map();

async function importKey(secret) {
  if (!secret) throw new Error("CREDENTIALS_KEY is not configured on this Worker");
  if (keys.has(secret)) return keys.get(secret);
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes (base64)");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  keys.set(secret, key);
  return key;
}

export async function encryptSecret(keySecret, plaintext, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await importKey(keySecret), enc.encode(plaintext));
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(keySecret, stored, context) {
  const [v, iv, ct] = String(stored || "").split(":");
  if (v !== "v1" || !iv || !ct) throw new Error("No stored credential");
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(context) }, await importKey(keySecret), unb64(ct)));
  } catch {
    throw new Error("Stored credential cannot be decrypted with this Worker's key");
  }
}

// Masks for display: never more than the public bot id and the last 4 characters.
export const maskToken = (t) => { const [id, rest = ""] = String(t).split(":"); return `${id}:••••${rest.slice(-4)}`; };
export const maskValue = (v) => (String(v).length <= 4 ? "••••" : `••••${String(v).slice(-4)}`);
