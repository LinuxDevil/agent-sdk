# Changelog

All notable changes to @loushy/build-ai-agent/sdk will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-09-28

### Added
- `createAgent()` agents can pause for approval (LOU-D21): a `needsApproval` tool no longer fails the run with "requires approval but no approvalStore". The run pauses (`finishReason: 'awaiting-approval'`) in a per-agent `InMemoryApprovalStore` (or the new `approvalStore` option), and `agent.approvals.list()` / `agent.approvals.resolve({ id, approved, note? })` continue it, in its session if it paused in one. The `approve` option decides calls in code without pausing.

### Changed
- BREAKING: `encrypt()` now generates a random salt per call instead of a hardcoded one. Ciphertext produced before this change cannot be decrypted with the new code and must be re-encrypted.
- BREAKING: The mock repositories (`MockAgentRepository`, `MockSessionRepository`, `MockResultRepository`, `MockMemoryRepository`, `MockAttachmentRepository` — previously re-exported from `src/data/mocks.ts` via the package root/`./data` subpath; this package has no `createMockRepositories` factory) are no longer exported from the package root. Import them from `@loushy/build-ai-agent/testing` instead.

## [1.0.0-alpha.8] - 2025-10-05

### Added
- ✅ Complete Phase 5 migration: Security, Storage, Templates, and Utils modules
- ✅ Security module with encryption, hashing, and quota validation
- ✅ Storage service with file locking mechanism
- ✅ Template rendering engine with Jinja2-like syntax
- ✅ Comprehensive utility functions (errors, formatters, validators)
- ✅ File extraction and processing utilities
- ✅ JSON path navigation utilities
- ✅ Framework-agnostic architecture (zero framework dependencies)

