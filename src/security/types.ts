/**
 * Security types and interfaces
 */

/**
 * Configuration for encryption operations
 */
export interface EncryptionConfig {
  secretKey: string;
  algorithm?: string;
  iterations?: number;
}

/**
 * Settings for DTO encryption
 */
export interface DTOEncryptionSettings {
  encryptedFields: string[];
}

/**
 * Authorization context for requests
 */
export interface AuthorizationContext {
  userId?: string;
  databaseIdHash: string;
  permissions: string[];
}
