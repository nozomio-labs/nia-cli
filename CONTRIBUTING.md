# Contributing to nia-cli

Thanks for your interest in contributing.

## Ways to contribute

- Report bugs
- Propose features and improvements
- Improve tests and documentation
- Submit code changes through pull requests

## Development setup

```sh
bun install
bun run dev --help
```

## Before opening a pull request

Run the local checks:

```sh
bun run check:types
bun run check
bun run test
```

## Coding expectations

- Keep changes focused and small when possible.
- Follow existing project style and patterns.
- Add or update tests for behavior changes.
- Avoid unrelated refactors in the same pull request.

## Commit and PR guidance

- Use clear commit messages (for example: `test: ...`, `fix: ...`, `feat: ...`).
- Explain what changed and why in the PR description.
- Include test evidence (commands run and outcomes).

Suggested PR template:

```md
## Summary
- What changed

## Why
- Why this change is needed

## Changes
- File or behavior highlights

## Validation
- Commands run and results
```

## Reporting bugs

Please include:

- Expected behavior
- Actual behavior
- Reproduction steps
- Environment details (OS, Bun version, Node version if relevant)

## Code of Conduct

By participating, you agree to follow the project Code of Conduct:

- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
