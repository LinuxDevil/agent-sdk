# Changelog

All notable changes to @loushy/build-ai-agent/sdk will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-09-28

### Added
- `AgentSpec.mcpServers` (LOU-D20): a validated map of MCP servers (stdio `command`/`args`/`env` or HTTP `url`/`headers`) in agent spec files. `loadSpec()` reports a bad entry with its name, `loushy doctor` reads the validated field instead of the raw file, and `specToAgent()` exposes the parsed servers as `agent.mcpServers` (connecting them is TODO(LOU-D20.2)). Existing specs are unaffected.

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

