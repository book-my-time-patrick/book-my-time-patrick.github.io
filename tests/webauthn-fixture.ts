import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/** Software-only authenticator for protocol tests. It does not model a real device or its UI. */
type Overrides = { origin?: string; rpID?: string; challenge?: string; userVerified?: boolean; userPresent?: boolean; counter?: number; badSignature?: boolean; crossOrigin?: boolean; topOrigin?: string };
type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const hash = (value: Uint8Array | string) => new Uint8Array(createHash('sha256').update(value).digest());
function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}
function uint32(value: number): Uint8Array {
  const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value); return data;
}
function head(major: number, length: number): Uint8Array {
  if (length < 24) return new Uint8Array([(major << 5) | length]);
  if (length < 256) return new Uint8Array([(major << 5) | 24, length]);
  if (length < 65536) return new Uint8Array([(major << 5) | 25, length >> 8, length & 255]);
  throw new Error('Test CBOR value exceeds fixture limits');
}
function cbor(value: CborValue): Uint8Array {
  if (typeof value === 'number') return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === 'string') { const data = new TextEncoder().encode(value); return concat(head(3, data.length), data); }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]));
}

export function makeAuthenticator(rpID: string, origin: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const credentialID = new Uint8Array(randomBytes(32));
  const id = encode(credentialID);
  let counter = 0;
  let userHandle: string | undefined;
  const publicKey = cbor(new Map<CborValue, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x!)], [-3, bytes(jwk.y!)]]));
  function clientData(type: string, challenge: string, overrides: Overrides): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge: overrides.challenge ?? challenge, origin: overrides.origin ?? origin, crossOrigin: overrides.crossOrigin ?? false, ...(overrides.topOrigin ? { topOrigin: overrides.topOrigin } : {}) }));
  }
  function authenticatorData(overrides: Overrides, attested: boolean): Uint8Array {
    const flags = (overrides.userPresent === false ? 0 : 1) | (overrides.userVerified === false ? 0 : 4) | (attested ? 64 : 0);
    const prefix = concat(hash(overrides.rpID ?? rpID), new Uint8Array([flags]), uint32(overrides.counter ?? counter));
    return attested ? concat(prefix, new Uint8Array(16), new Uint8Array([credentialID.length >> 8, credentialID.length & 255]), credentialID, publicKey) : prefix;
  }
  return {
    id,
    register(options: PublicKeyCredentialCreationOptionsJSON, overrides: Overrides = {}): RegistrationResponseJSON {
      userHandle = options.user.id;
      counter = overrides.counter ?? 0;
      const attestationObject = cbor(new Map<CborValue, CborValue>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authenticatorData(overrides, true)]]));
      return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: { clientDataJSON: encode(clientData('webauthn.create', options.challenge, overrides)), attestationObject: encode(attestationObject), transports: ['internal'] } };
    },
    authenticate(options: PublicKeyCredentialRequestOptionsJSON, overrides: Overrides = {}): AuthenticationResponseJSON {
      counter = overrides.counter ?? counter + 1;
      const client = clientData('webauthn.get', options.challenge, overrides);
      const authData = authenticatorData(overrides, false);
      const signature = sign('sha256', concat(authData, hash(client)), pair.privateKey);
      if (overrides.badSignature) signature[signature.length - 1] ^= 1;
      return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: { clientDataJSON: encode(client), authenticatorData: encode(authData), signature: encode(signature), ...(userHandle ? { userHandle } : {}) } };
    },
  };
}

/** Independent TOTP implementation; time is a Unix timestamp in milliseconds. */
export function totp(secret: string, time = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bits = 0;
  const decoded: number[] = [];
  for (const letter of secret.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(letter);
    if (value < 0) throw new Error('Invalid test TOTP secret');
    buffer = (buffer << 5) | value; bits += 5;
    if (bits >= 8) { bits -= 8; decoded.push((buffer >>> bits) & 255); }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', Buffer.from(decoded)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
