# Contributing

Keep changes small and concrete. The runtime is Python + SQLite and plain JavaScript; adapters share one renderer and editor. Prefer hard cutovers over migration or compatibility layers while this project is in development. See [AGENTS.md](AGENTS.md).

## Check a change

```sh
uv sync --locked
npm ci
npx playwright install chromium
uv run pytest -q
npm test
npm run test:browser
```

The tests use disposable books and a disposable browser profile. They never read your actual token, database, or saved labels. On Linux, use `npx playwright install --with-deps chromium` for the browser's system dependencies.

To reproduce the README screenshots, run `npm run screenshots`. The demo uses sample data and the shipped controller, editor, and styles. To regenerate toolbar icons after editing `extension/icons/book.svg`, run `npm run icons`.

After changing extension code, reload 0xlabel on the browser's extensions page and refresh enabled websites. Restart the helper only when its Python code changes.

[Architecture](docs/architecture.md) · [Adapters](docs/adapters.md) · [Style](docs/style.md) · [Test coverage](docs/testing.md)
