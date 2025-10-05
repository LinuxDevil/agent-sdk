import { describe, it, expect } from 'vitest';
import { validateTokenQuotas } from './quotas';
import { SaaSContext } from './types';

describe('Security - Quotas', () => {
  describe('validateTokenQuotas', () => {
    it('should return OK when SaaS is not enabled', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: {},
        currentUsage: {},
      };
      const result = validateTokenQuotas(context, false);
      expect(result.status).toBe(200);
      expect(result.message).toContain('SaaS is not enabled');
    });

    it('should reject when email is not verified', () => {
      const context: SaaSContext = {
        emailVerified: false,
        currentQuota: {},
        currentUsage: {},
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(403);
      expect(result.message).toContain('verify e-mail');
    });

    it('should reject when results quota exceeded', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: { allowedResults: 100 },
        currentUsage: { usedResults: 150 },
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(403);
      expect(result.message).toContain('limit of results');
    });

    it('should reject when sessions quota exceeded', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: { allowedSessions: 50 },
        currentUsage: { usedSessions: 60 },
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(403);
      expect(result.message).toContain('limit of sessions');
    });

    it('should reject when USD budget quota exceeded', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: { allowedUSDBudget: 10 },
        currentUsage: { usedUSDBudget: 15 },
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(403);
      expect(result.message).toContain('AI Tokens Limit');
    });

    it('should allow when within quota limits', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: {
          allowedResults: 100,
          allowedSessions: 50,
          allowedUSDBudget: 10,
        },
        currentUsage: {
          usedResults: 50,
          usedSessions: 25,
          usedUSDBudget: 5,
        },
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(200);
      expect(result.message).toBe('All OK!');
    });

    it('should allow when quota is 0 (unlimited)', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: {
          allowedResults: 0,
          allowedSessions: 0,
          allowedUSDBudget: 0,
        },
        currentUsage: {
          usedResults: 1000,
          usedSessions: 500,
          usedUSDBudget: 100,
        },
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(200);
      expect(result.message).toBe('All OK!');
    });

    it('should allow when exactly at quota limit', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: {
          allowedResults: 100,
          allowedSessions: 50,
          allowedUSDBudget: 10,
        },
        currentUsage: {
          usedResults: 100,
          usedSessions: 50,
          usedUSDBudget: 10,
        },
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(200);
      expect(result.message).toBe('All OK!');
    });

    it('should handle missing usage values', () => {
      const context: SaaSContext = {
        emailVerified: true,
        currentQuota: {
          allowedResults: 100,
        },
        currentUsage: {},
      };
      const result = validateTokenQuotas(context, true);
      expect(result.status).toBe(200);
      expect(result.message).toBe('All OK!');
    });
  });
});
