# Contributing to @tajwal/build-ai-agent

Thank you for your interest in contributing to the Build AI Agent SDK! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm, pnpm, or yarn

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/agent-sdk.git
   cd agent-sdk
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```
5. Run tests:
   ```bash
   npm test
   ```

## Development Workflow

### Making Changes

1. Create a new branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes

3. Ensure your code passes all checks:
   ```bash
   npm run typecheck  # Type checking
   npm run lint       # Linting
   npm test           # Tests
   npm run build      # Build
   ```

4. Commit your changes with a descriptive commit message

5. Push to your fork and create a pull request

### Code Style

- Use TypeScript for all code
- Follow existing code patterns and conventions
- Add JSDoc comments for public APIs
- Keep functions small and focused
- Write meaningful variable and function names

### Testing

- Write tests for new features
- Ensure all existing tests pass
- Aim for good test coverage
- Tests are located alongside source files with `.test.ts` extension

### Documentation

- Update README.md if adding new features
- Add JSDoc comments for new public APIs
- Update CHANGELOG.md for notable changes

## Pull Request Process

1. Ensure your PR includes:
   - Clear description of changes
   - Tests for new functionality
   - Updated documentation if needed

2. Your PR will be reviewed by maintainers

3. Address any feedback

4. Once approved, your PR will be merged

## Reporting Issues

When reporting issues, please include:

- A clear and descriptive title
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Node.js version
- Operating system
- Any relevant code snippets or error messages

## Feature Requests

Feature requests are welcome! Please:

- Check existing issues to avoid duplicates
- Provide a clear use case
- Explain why this feature would be useful

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open an issue for any questions about contributing.
