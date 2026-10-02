# create-lousho-agent

Scaffold a new [`@lousho/build-ai-agent`](https://www.npmjs.com/package/@lousho/build-ai-agent) project with one command:

```bash
npm create lousho-agent my-agent
cd my-agent
cp .env.example .env     # put your API key in .env
npm run dev              # chat with your agent in the terminal
npm test                 # offline tests: no API key needed
```

You get an agent with an example tool, an offline test that uses a mock model, a `.env.example` for your provider, a strict `tsconfig.json` and a README. Dependencies are installed and `git init` is run for you. Requires Node.js 22.19 or newer.

## Options

Without arguments it asks for the directory, the provider and the template. For scripts, pass `--yes` and any of:

| Option | Values |
| ------ | ------ |
| `--provider` | `openai`, `anthropic`, `openrouter`, `ollama` |
| `--template` | `minimal`, `tools`, `yaml` |
| `--package-manager` | `npm`, `pnpm`, `yarn`, `bun` |
| `--no-install` | skip installing dependencies |
| `--no-git` | skip `git init` |
| `--force` | write into a non-empty directory |

With npm, put the options after `--`:

```bash
npm create lousho-agent my-agent -- --yes --provider anthropic --template tools
```

This package is a thin wrapper: it runs `lousho init` from the SDK, so `npx lousho init --help` lists every option.

## Links

- Documentation: [lousho.com](https://lousho.com) (English and Arabic)
- Quick start: [lousho.com/quickstart](https://lousho.com/quickstart)
- Source: [github.com/LinuxDevil/agent-sdk](https://github.com/LinuxDevil/agent-sdk)

MIT licensed.
