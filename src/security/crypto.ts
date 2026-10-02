/**
 * Cryptographic utilities for encryption, decryption, and hashing
 */

import { DTOEncryptionSettings } from './types';

/**
 * Thrown when decryption fails, instead of silently returning the raw
 * ciphertext as if it were the decrypted value.
 */
export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

/** Lower-case hex encoding of `bytes`, two digits per byte. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Inverse of toHex(): parse two hex digits per byte. */
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array((hex.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16)));
}

/** Encryption output: the random salt and IV used, plus the ciphertext. */
interface EncryptedParts {
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  cipherText: ArrayBuffer;
}

/**
 * Encryption utility class using AES-GCM encryption
 */
export class EncryptionUtils {
  private secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  /**
   * Retained for API compatibility. Key derivation is now salt-dependent and
   * happens per-encryption/decryption (see deriveKey/importKeyForSalt), so
   * there is no longer a single cacheable key to pre-generate.
   */
  async generateKey(secretKey: string): Promise<void> {
    this.secretKey = secretKey;
  }

  /**
   * Derive encryption key bits from secret + salt using PBKDF2
   */
  private async deriveKey(secretKey: string, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const iterations = 100000; // Adjust the number of iterations as needed
    const keyLength = 256; // 256 bits (32 bytes)
    const derivedKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secretKey),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    return crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      derivedKey,
      keyLength
    );
  }

  /**
   * Import an AES-GCM key derived from the current secret and the given salt
   */
  private async importKeyForSalt(salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const keyData = await this.deriveKey(this.secretKey, salt);
    return crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  /**
   * AES-GCM-encrypt `data` under a key derived with a fresh random salt
   */
  private async encryptWithFreshSalt(data: BufferSource): Promise<EncryptedParts> {
    const salt = crypto.getRandomValues(new Uint8Array(16)); // Random salt per encryption
    const iv = crypto.getRandomValues(new Uint8Array(16)); // Initialization vector
    const key = await this.importKeyForSalt(salt);
    const cipherText = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      key,
      data
    );
    return { salt, iv, cipherText };
  }

  /**
   * Encrypt ArrayBuffer data
   */
  async encryptArrayBuffer(data: ArrayBuffer): Promise<ArrayBuffer> {
    const { salt, iv, cipherText } = await this.encryptWithFreshSalt(data);
    return new Blob([salt, iv, new Uint8Array(cipherText)]).arrayBuffer(); // Prepend salt + IV to the ciphertext
  }

  /**
   * Convert Blob to ArrayBuffer
   */
  async blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }

  /**
   * Decrypt ArrayBuffer data
   */
  async decryptArrayBuffer(encryptedData: ArrayBuffer | Blob): Promise<ArrayBuffer> {
    let encryptedArrayBuffer: ArrayBuffer;
    if (encryptedData instanceof Blob) {
      encryptedArrayBuffer = await this.blobToArrayBuffer(encryptedData);
    } else {
      encryptedArrayBuffer = encryptedData;
    }

    try {
      const salt = new Uint8Array(encryptedArrayBuffer.slice(0, 16)); // Extract the salt
      const iv = new Uint8Array(encryptedArrayBuffer.slice(16, 32)); // Extract the IV
      const cipherText = encryptedArrayBuffer.slice(32);
      const key = await this.importKeyForSalt(salt);

      return await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv,
        },
        key,
        cipherText
      );
    } catch (e) {
      throw new DecryptionError('Failed to decrypt array buffer', { cause: e });
    }
  }

  /**
   * Encrypt string text
   */
  async encrypt(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const { salt, iv, cipherText } = await this.encryptWithFreshSalt(data);
    return toHex(salt) + toHex(iv) + toHex(new Uint8Array(cipherText));
  }

  /**
   * Decrypt string text
   */
  async decrypt(cipherText: string): Promise<string> {
    // Empty input passes through unchanged
    if (!cipherText) {
      return cipherText;
    }
    try {
      const salt = fromHex(cipherText.slice(0, 32));
      const iv = fromHex(cipherText.slice(32, 64));
      const encryptedArray = fromHex(cipherText.slice(64));

      const key = await this.importKeyForSalt(salt);
      const decryptedData = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encryptedArray
      );
      const decoder = new TextDecoder();
      return decoder.decode(decryptedData);
    } catch (e) {
      throw new DecryptionError('Failed to decrypt value', { cause: e });
    }
  }
}

/**
 * Generate a random password
 */
export function generatePassword(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...key));
}

/**
 * Whether a DTO field gets encrypted/decrypted: the listed fields when
 * settings are given, otherwise every string or object field.
 */
function isProcessedField(
  key: string,
  value: unknown,
  encryptionSettings: DTOEncryptionSettings | undefined
): boolean {
  if (encryptionSettings) {
    return encryptionSettings.encryptedFields.indexOf(key) >= 0;
  }
  return typeof value === 'string' || typeof value === 'object';
}

/**
 * DTO encryption filter for encrypting/decrypting object fields
 */
export class DTOEncryptionFilter<T> {
  private utils: EncryptionUtils;

  constructor(secretKey: string) {
    this.utils = new EncryptionUtils(secretKey);
  }

  /**
   * Encrypt specified fields in a DTO
   */
  async encrypt(dto: T, encryptionSettings?: DTOEncryptionSettings): Promise<T> {
    return this.process(dto, encryptionSettings, async (value) => {
      if (value) {
        if (typeof value === 'object') {
          // Check if it's a Date object
          if (Object.prototype.toString.call(value) === '[object Date]') {
            value = (value as Date).toISOString();
          }
          return 'json-' + (await this.utils.encrypt(JSON.stringify(value)));
        }
        return await this.utils.encrypt(value);
      } else {
        return value;
      }
    });
  }

  /**
   * Decrypt specified fields in a DTO
   */
  async decrypt(dto: T, encryptionSettings?: DTOEncryptionSettings): Promise<T> {
    return this.process(dto, encryptionSettings, async (value) => {
      if (value) {
        if (typeof value === 'string' && value.startsWith('json-')) {
          return JSON.parse(await this.utils.decrypt(value.slice(5)));
        }
        return await this.utils.decrypt(value);
      } else {
        return value;
      }
    });
  }

  /**
   * Process DTO fields with a transformation function
   */
  private async process(
    dto: T,
    encryptionSettings: DTOEncryptionSettings | undefined,
    processFn: (value: string) => Promise<string>
  ): Promise<T> {
    const result = {} as T;
    for (const key in dto) {
      if (isProcessedField(key, dto[key], encryptionSettings)) {
        result[key] = (await processFn(dto[key] as string)) as T[typeof key];
      } else {
        result[key] = dto[key];
      }
    }
    return result;
  }
}

/**
 * Generate SHA-256 hash with salt
 */
export async function sha256(message: string, salt: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message + salt); // encode as (utf-8) Uint8Array
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8); // hash the message
  return toHex(new Uint8Array(hashBuffer)); // convert bytes to hex string
}
