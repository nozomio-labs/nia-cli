# nia-cli

CLI for [Nia](https://www.trynia.ai/).

## Quick Start

```sh
# Install dependencies
bun install

# Explore commands
bun run dev --help
```

## Authentication

Provide your Nia API key via env var or the auth command:

```sh
# Option 1: environment variable
export NIA_API_KEY=nia_your_api_key

# Option 2: store key in local config
nia auth login --api-key nia_your_api_key

# Check active auth source
nia auth status
```

## Command Examples

```sh
# Search indexed sources
nia search query "How does auth middleware work?"

# Search the web
nia search web "latest OpenTelemetry collector changes" --category github

# Index and inspect a repository
nia repos index vercel/ai
nia repos list

# Index documentation sources
nia sources index https://docs.anthropic.com

# Add and sync a local folder
nia local add ~/dev/my-project
nia local sync
nia local watch

# Search only local folders
nia search query "Where is auth configured?" --local-folders my-project

# Run autonomous research
nia oracle create "Compare RAG evaluation frameworks"

# View account usage
nia usage
```

## Global Flags

All commands inherit these options:

- `--api-key` Override API key for a single command
- `--verbose` Enable verbose output
- `--color` Toggle colored output
- `--output` Output format: `json`, `table`, or `text` (default). `table` is best for flat, list-style results
- `--json` Shorthand for `--output json`

## Development

```sh
# Run in dev mode
bun run dev

# Type-check
bun run check:types

# Run tests
bun run test

# Lint and static checks
bun run check

# Build standalone executable
bun run build

# Run built CLI
bun run start
```

## Community

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
