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
 * Quota configuration for SaaS mode
 */
export interface QuotaConfig {
  allowedResults?: number;
  allowedSessions?: number;
  allowedUSDBudget?: number;
}

/**
 * Current usage statistics
 */
export interface UsageStats {
  usedResults?: number;
  usedSessions?: number;
  usedUSDBudget?: number;
}

/**
 * Authorization context for requests
 */
export interface AuthorizationContext {
  userId?: string;
  databaseIdHash: string;
  permissions: string[];
}

/**
 * SaaS context with quota and usage information
 */
export interface SaaSContext {
  emailVerified: boolean;
  currentQuota: QuotaConfig;
  currentUsage: UsageStats;
}

/**
 * Result of quota validation
 */
export interface QuotaValidationResult {
  message: string;
  status: number;
}
