const encoder = new TextEncoder();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid encoding');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), char => char.charCodeAt(0));
}
export function randomToken(bytes = 32): string { return base64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function equalText(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return result + (bits ? alphabet[(value << (5 - bits)) & 31] : '');
}
export function fromBase32(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Z2-7]+$/.test(value)) throw new Error('Invalid secret');
  let bits = 0, accumulator = 0;
  const result: number[] = [];
  for (const char of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { result.push((accumulator >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(result);
}
export function newTotpSecret(): string { return base32(crypto.getRandomValues(new Uint8Array(20))); }
export async function hmac(key: Uint8Array<ArrayBuffer>, text: string): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(text))));
}
export async function totpAtStep(secret: string, step: number): Promise<string> {
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey('raw', fromBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, '0');
}
export async function matchingTotpStep(secret: string, code: string, now = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  const matches = await Promise.all([-1, 0, 1].map(async offset => ({ step: step + offset, valid: equalText(await totpAtStep(secret, step + offset), code) })));
  return matches.filter(item => item.valid).reduce<number | null>((result, item) => Math.max(result ?? -1, item.step), null);
}
async function encryptionKey(encoded: string): Promise<CryptoKey> {
  const bytes = fromBase64url(encoded);
  if (bytes.length !== 32) throw new Error('Invalid key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
type SecretPurpose = 'totp' | 'mail-api-key' | 'calendar-icloud' | 'calendar-outlook' | 'calendar-oauth';
export async function encryptSecret(secret: string, encodedKey: string, purpose: SecretPurpose = 'totp'): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(encodedKey);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`invited-booking:${purpose}:v1`) }, key, encoder.encode(secret));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function decryptSecret(encoded: string, encodedKey: string, purpose: SecretPurpose = 'totp'): Promise<string> {
  const [version, iv, ciphertext, extra] = encoded.split('.');
  if (version !== 'v1' || !iv || !ciphertext || extra) throw new Error('Invalid ciphertext');
  const key = await encryptionKey(encodedKey);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(iv), additionalData: encoder.encode(`invited-booking:${purpose}:v1`) }, key, fromBase64url(ciphertext));
  return new TextDecoder().decode(plain);
}
