# Test coverage

The main suites contain 70 checks: 17 Python backend, 9 cache-client, 2 checksum, and 42 browser tests. The [contributing guide](../CONTRIBUTING.md) lists the commands; GitHub Actions runs them against the committed lockfiles.

## What is checked

- **API and SQLite:** authentication, validation, ranked names, scopes, atomic replacement and deletion, conflicting and simultaneous edits, persistence, and independent installations. Token and database files use private permissions where supported.
- **Books and synchronization:** caches separated by the full API URL, Local → empty Remote → Local without writes, snapshot deletion, malformed downloads, failed requests, source-bound drafts, late responses, and uncertain-save recovery across a worker restart.
- **Browser integration:** the shipped worker, storage, alarms, popup, content script, HTTP and HTTPS APIs, credential-free exports, restricted content-script messages and storage, active/paused toolbar states, and complete site-disable cleanup.
- **Native behavior:** 500 addresses, unchanged native text and selection, links and modifier clicks, native copy sources, keyboard focus, stable inline tag placement, and no hover positioning or hit tests. Label substitution restores the original presentation when disabled.
- **Editing:** captured identity and source, recycled rows, preserved drafts, conflicts, ranking, Enter and IME handling, autofill exclusions, compact layout, outside dismissal, and a confirmed-save checkmark before closing. A delayed completion cannot close a newer editor.
- **Temporary comparison:** the eye reveals matching addresses on one chain, retains tags and drafts, survives rows/sync/saves, and suppresses global fallback. Navigation or book switching resets it. The installed extension verifies independence between tabs, unchanged API records, and restoration after a real page reload.
- **Scrolling and search:** document scrolling performs no editor positioning reads or writes; inner scrollers, resizing, growing panels, and detached drafts remain usable. Empty and 1,000-record books avoid per-letter requests and retain unchanged search rows.
- **Adapters:** canonical explorer links, ENS and preset names, named homepage fee recipients, transaction-table spans, Safe headers, contradictory identities, loading, paused integrations, and conservative generic detection. Unknown abbreviations stay native.

Checksum tests use all eight official [EIP-55 vectors](https://eips.ethereum.org/EIPS/eip-55). Display and extension copying use the checksum; storage and exports remain lowercase.

Tests use disposable databases, tokens, certificates, and browser profiles. They never open a user's real book. A test-only manifest pre-grants fixture permissions; the application JavaScript is unchanged. Certificate exceptions apply only to the HTTPS test browser. Native permission prompts require a human click.

## Demo screenshots

`npm run screenshots` renders the README images in light and dark mode. It uses a small authored transfer-list fixture, EIP-55 example addresses, fictional names and amounts, and the actual page controller, editor, and CSS. Its save callback deliberately rejects writes. No real account, credentials, or book is involved. It is a separate capture check, not part of the 70-test count.

## Live-site limits

Fixtures and public markup checks do not prove support for every explorer route or future website change. The adapters deliberately pause on inconsistent evidence and leave unresolved addresses alone. Public bot checks may block an automated browser; an optional smoke check is available with `OXLABEL_LIVE=1 npm run test:browser`. Website permission prompts and password-manager vaults are outside headless test control.

This is an active development project with one current contract. Required package and Chrome manifest versions stay fixed at `1`; edit-conflict tokens and message-order counters remain for data integrity. See [AGENTS.md](../AGENTS.md) and the [adapter contract](adapters.md).
