/**
 * The `<forge-chat>` widget's stylesheet (X04a), injected as a `<style>`
 * into the shadow root. Raw hex values are intentional: the widget runs
 * outside Studio and cannot read `theme.css`, so it themes itself through
 * the `--forge-chat-*` custom properties declared on `:host`.
 */
export const FORGE_CHAT_STYLES = `
:host {
  --forge-chat-accent: #4f46e5;
  --forge-chat-bg: #ffffff;
  --forge-chat-fg: #18181b;
  --forge-chat-muted: #52525b;
  --forge-chat-border: #e4e4e8;
  --forge-chat-radius: 12px;
  --forge-chat-font: system-ui, sans-serif;
  display: block;
  font-family: var(--forge-chat-font);
  color: var(--forge-chat-fg);
  background: var(--forge-chat-bg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --forge-chat-bg: #111114;
    --forge-chat-fg: #f4f4f5;
    --forge-chat-muted: #a1a1aa;
    --forge-chat-border: #26262c;
    --forge-chat-accent: #8b8cf8;
  }
}
.fc {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
  border: 1px solid var(--forge-chat-border);
  border-radius: var(--forge-chat-radius);
  background: var(--forge-chat-bg);
  color: var(--forge-chat-fg);
  overflow: hidden;
}
.fc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--forge-chat-border);
}
.fc-title {
  font-weight: 600;
  font-size: 14px;
}
.fc-reset {
  border: 0;
  background: transparent;
  color: var(--forge-chat-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}
.fc-reset:hover {
  color: var(--forge-chat-fg);
  background: var(--forge-chat-border);
}
.fc-log {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}
@media (prefers-reduced-motion: reduce) {
  .fc-log {
    scroll-behavior: auto;
  }
}
.fc-msg {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.45;
}
.fc-msg-user {
  align-self: flex-end;
  background: var(--forge-chat-accent);
  color: #ffffff;
}
.fc-msg-agent {
  align-self: flex-start;
  background: var(--forge-chat-border);
}
.fc-tool {
  align-self: flex-start;
  color: var(--forge-chat-muted);
  font-size: 12px;
  font-style: italic;
  padding: 0 4px;
}
.fc-error {
  align-self: stretch;
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
@media (prefers-color-scheme: dark) {
  .fc-error {
    color: #fca5a5;
    background: #3f1d1d;
    border-color: #7f2d2d;
  }
}
.fc-form {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--forge-chat-border);
}
.fc-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.fc-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--forge-chat-border);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  color: var(--forge-chat-fg);
  background: var(--forge-chat-bg);
}
.fc-input:focus {
  outline: 2px solid var(--forge-chat-accent);
  outline-offset: -1px;
}
.fc-input:disabled {
  opacity: 0.6;
}
.fc-send {
  border: 0;
  border-radius: 8px;
  padding: 8px 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  background: var(--forge-chat-accent);
  color: #ffffff;
}
.fc-send:disabled {
  opacity: 0.6;
  cursor: default;
}
`;
