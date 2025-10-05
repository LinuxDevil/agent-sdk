# Changelog

All notable changes to @tajwal/build-ai-agent/sdk will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Changed
- Improved error handling across all modules
- Enhanced type safety with better TypeScript definitions
- Optimized bundle size (120KB ESM)

### Fixed
- Various bug fixes in execution engine
- Improved streaming response handling

## [1.0.0-alpha.7] - 2025-01-10

### Added
- Agent execution engine with memory management
- Context builder for conversation history
- Retry logic with exponential backoff
- Circuit breaker pattern for resilience

## [1.0.0-alpha.6] - 2025-01-09

### Added
- LLM provider abstraction layer
- OpenAI provider implementation
- Ollama provider implementation
- Mock provider for testing

## [1.0.0-alpha.5] - 2025-01-08

### Added
- Repository pattern for data access
- Domain models
- Mock implementations for testing
- Drizzle ORM adapter (separate package)

## [1.0.0-alpha.4] - 2025-01-07

### Added
- Flow system with visual workflow builder
- Flow executors (Sequential, Parallel, Conditional)
- Flow validation and conversion utilities
- Input processing for flows

## [1.0.0-alpha.3] - 2025-01-06

### Added
- Tool registry system
- Built-in tools (HTTP, Email, Date utilities)
- Custom tool support
- Tool execution engine

## [1.0.0-alpha.2] - 2025-01-05

### Added
- Agent type registry
- Agent validators
- Core configuration management

## [1.0.0-alpha.1] - 2025-01-04

### Added
- Initial release
- Core type definitions
- AgentBuilder API
- Basic agent configuration

[1.0.0-alpha.8]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.7...v1.0.0-alpha.8
[1.0.0-alpha.7]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.6...v1.0.0-alpha.7
[1.0.0-alpha.6]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.5...v1.0.0-alpha.6
[1.0.0-alpha.5]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.4...v1.0.0-alpha.5
[1.0.0-alpha.4]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.3...v1.0.0-alpha.4
[1.0.0-alpha.3]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/your-org/tajwal/build-ai-agent/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/your-org/tajwal/build-ai-agent/releases/tag/v1.0.0-alpha.1
