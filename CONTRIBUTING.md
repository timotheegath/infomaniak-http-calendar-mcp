# Contributing

Thanks for your interest in the Infomaniak Calendar MCP server.

## Setup

```bash
npm ci
npm test
```

`npm test` builds the project and runs the test suite. There is no separate
lint or typecheck script — the test gate is the verification step.

## Pull requests

- Open PRs against the `main` branch.
- Ensure `npm test` passes before requesting review.
- Keep changes focused. A PR should address one concern.
- Update tests if you change behaviour.

## Secrets

Do not commit real `CALENDAR_TOKEN` values, `.env` files, or any other
credentials. The `.gitignore` and `.dockerignore` exclude `.env` by default;
double-check that you are not adding secrets to tracked files.