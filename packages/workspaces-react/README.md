# @lousho/workspaces-react

## What it is

Renders a Lousho page UI (`lousho.ui/1`) in any React 18 or later app. `<PageApp>` takes an `ApiClient`, a workspace id and a page id, loads the UI spec and the effective input schema through the client, and draws the closed component catalog. It never takes a URL, so a host binds the client to its own server-side proxy.

## Use

```tsx
import { createFetchClient } from 'lousho/workspaces/client';
import { PageApp } from '@lousho/workspaces-react';
import '@lousho/workspaces-react/styles.css';

const client = createFetchClient({ baseUrl: '/api/lousho' });

export function InstagramApp() {
  return <PageApp client={client} workspaceId="marketing" pageId="instagram-videos" />;
}
```

## Theming

The stylesheet reads CSS variables; set them on any ancestor (or `:root`) to theme the UI.

| Variable | Colours |
| --- | --- |
| `--lousho-ui-font` | The font family of the whole page UI. |
| `--lousho-ui-text` | Primary text. |
| `--lousho-ui-muted` | Notes, hints and inactive tabs. |
| `--lousho-ui-bg` | The page background behind the root. |
| `--lousho-ui-surface` | Inputs, buttons and card backgrounds. |
| `--lousho-ui-border` | Borders of inputs, buttons, cards and tables. |
| `--lousho-ui-accent` | The primary button and focus/selected outlines. |
| `--lousho-ui-on-accent` | Text on the primary button. |
| `--lousho-ui-danger` | Error text. |
| `--lousho-ui-radius` | Border radius of inputs, buttons and cards. |
| `--lousho-ui-gap` | Spacing between stacked elements. |
| `--lousho-ui-mono` | The font of JSON output. |

## Safety (R15)

Every label, title, placeholder and piece of model output is drawn as a React text node; there is no HTML, script, remote URL or `eval`, and artifacts come only through the client. Hosts theme it with the `--lousho-ui-*` CSS variables listed above. There is no Next.js-specific code: in Next.js use it in a client component and point `baseUrl` at your server-side proxy route.
