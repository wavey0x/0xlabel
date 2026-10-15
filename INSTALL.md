# Setup

0xtagger is a Python helper and an unpacked Chrome/Brave extension. The helper owns a SQLite book; the extension caches each connected API separately. Normal use requires no Node installation or application build.

## Run on your laptop

Use Python 3.10+ and [uv](https://docs.astral.sh/uv/getting-started/installation/):

```sh
git clone https://github.com/wavey0x/0xtagger.git
cd 0xtagger
uv run 0xtagger
```

The first run creates `~/.local/share/0xtagger/tags.sqlite3` and a random access token in `token.txt`. The helper listens on `http://127.0.0.1:8712`. Leave it running or start the same command through your operating system's login-service facility.

Without uv:

```sh
python3 -m venv .venv
.venv/bin/pip install .
.venv/bin/0xtagger
```

On Windows, use `.venv\Scripts\pip` and `.venv\Scripts\0xtagger`.

## Load the extension

Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's **extension** folder. Do not load the repository root. Chrome 125 or newer is required. Pin 0xtagger to the toolbar.

0xtagger starts with one address book kept on this device. There is nothing to connect and nothing to configure.

Open a supported website, then turn on the popup's **On this website** switch. The toolbar turns deep purple when tagging is active. Permissions are granted per website; other sites remain untouched. **Open address book** opens a full-page extension tab for searching, adding, editing, removing, importing, and exporting tags.

Click the purple tag glyph beside an address to edit its tags. The first tag is the default; + appends another and arrows reorder them. Enter saves; Escape or an outside click dismisses the draft. Turn off **Show tags** to temporarily reveal the website's original presentation for matching occurrences on that page. The popup's **On this website** switch restores every website default and persists across refreshes.

New inline tags apply globally. Editing an existing network override retains its scope. **Add address** in the full-page book offers an optional chain ID for a scoped list; removing that override reveals the global tags. The address switch suppresses the whole replacement until restored or reset by refresh, navigation, or switching books. **Remove tags** in the book editor prepares a deletion; Save commits it.

## Keep a book on a server

A book on a server can be reached from more than one device. Run the helper on your machine, or on a remote one behind an HTTPS reverse proxy:

```sh
uv run 0xtagger --public-url https://tags.example.com
```

For example, configure Caddy to forward to the helper's loopback listener:

```caddyfile
tags.example.com {
    reverse_proxy 127.0.0.1:8712
}
```

Use a reachable hostname and valid certificate. If serving under a path, pass the full base URL to `--public-url` and strip that path at the proxy. Requests reject redirects, so use the API's final URL.

The helper prints one line. In either view, open the address book menu, choose **Connect to a server**, and paste it. The book is named for where it is kept — **Local server** for one on this machine, the hostname otherwise — and can be renamed in its own row afterwards. A server that is already one of your books opens rather than being added twice. The key travels in the link's fragment, which your browser never sends to the server, and the field is cleared as soon as it has been used. Keep the line private.

Connecting and copying are separate: a book opens as it is. If it turns out to be empty and the one you were looking at was not, you are asked once whether to carry those addresses over, and the copy is the same single transaction a file import gets.

Books are separate and switching between them changes neither, so the book on your device stays exactly as it was while you use one kept on a server. A book is renamed in its own row in the list: hover it and click the pencil, or press F2 with the row focused. The trash button beside the book name removes the book that is open — removing one kept on a server only forgets it here, while removing one kept on this device deletes its addresses. **Import** in the full-page book carries addresses from an exported file into the book that is open.

For a book kept on a server, sync is a read-only snapshot pull, asked for where you are about to look at the book: opening the popup, switching to it, a page coming back to the front, opening an editor, and startup — at most once a minute however many of those arrive together, plus a five-minute backstop and the manual refresh. The pull is conditional, so a book that has not changed answers in a few hundred bytes and nothing downstream is told anything. A book kept on this device is never pulled, since nothing else writes it. Failed pulls keep the previous copy. An explicit save is the only operation that changes a book; saving to a server book needs that server. Conflicting or failed saves preserve the draft. Importing a file writes it in batches, each one applied by the server whole or not at all.

## Data and backups

Choose a different port or data directory:

```sh
uv run 0xtagger --port 8713 --data-dir /path/to/book
```

`OXTAGGER_DATA_DIR` sets the directory, and `OXTAGGER_TOKEN` supplies a token instead of `token.txt`. Restart the helper after changing its token and update that connection in the popup. Keep credentials and books outside the checkout.

In the browser, records live in the extension's IndexedDB database, keyed by book, network scope and address; the books themselves — their names, where each is kept, and any access keys — live in extension storage restricted to trusted contexts. The `unlimitedStorage` permission is what keeps that database exempt from being evicted under storage pressure, so do not remove it as redundant.

**Export book** on the full-page view downloads the selected book's records without credentials. For a complete server backup, stop the helper and copy `tags.sqlite3` and `token.txt`. Restore them to that installation's data directory before restarting. Switching APIs does not transfer or merge data.

## Updates and privacy

This is an unpacked development extension. After editing or pulling its code, reload 0xtagger on the extensions page and refresh enabled websites. The manifest pins a public `key`, so the extension keeps one id — `odmejkpnlpbgpbohiejgiappnlohlgbj` — and therefore its stored books, wherever the checkout sits. Moving the folder still needs a **Load unpacked** from the new location, but nothing is lost when you do. Restart the helper when its Python code changes. Address-book sync is independent of code reloads.

Displayed tags are part of the website's DOM and readable by that website. Credentials remain in trusted extension storage. A website's own stored address book is read only in response to **Import names from Safe** in the popup, through that site's adapter, and the names it returns are reviewed in the address-book tab before anything is written; nothing is read while you browse, and a website can neither start an import nor learn what your book already holds. Etherscan-family explorers and Safe have dedicated adapters; other enabled sites use full-address detection. Embedded views on the enabled website's own origin are included, such as Etherscan's token-transfer tabs; frames from other origins remain untouched. Inputs, signing controls, unresolved abbreviations, and ambiguous addresses are skipped. An inconsistent site integration pauses tagging and offers Retry in the popup.

## Development checks

```sh
uv sync --locked
npm ci
npx playwright install chromium
uv run pytest -q
npm test
npm run test:browser
```

On Linux, use `npx playwright install --with-deps chromium`. Tests use disposable books and browser profiles. They focus on identity, data integrity, credential boundaries, and native website behavior.

`npm run screenshots` reproduces the README examples using sample data and the actual extension. All extension colors live in `extension/colors.js`, including the light/dark palettes, accent tints, and toolbar states. After changing that palette or the mark in `extension/icons.js`, run `npm run assets` to regenerate the shared stylesheet, wordmark SVG, and toolbar PNGs, then reload the extension.

The app is in active development. Prefer hard cutovers over migrations and compatibility layers; see [AGENTS.md](AGENTS.md).
