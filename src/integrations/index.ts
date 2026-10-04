/**
 * Integrations (A1)
 * The credentialed third-party tools - Jira, GitHub, Slack and email. They
 * used to ship on the package root (and `./tools`); import them from
 * `@lousho/build-ai-agent/integrations`. The files themselves still live in
 * `src/tools/built-in/`; this barrel only re-exports them.
 */

export * from '../tools/built-in/email';
export * from '../tools/built-in/jira';
export * from '../tools/built-in/github';
export * from '../tools/built-in/slack';
