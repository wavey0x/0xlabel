# Setup

0xlabel is a Python helper and an unpacked Chrome/Brave extension. The helper owns a SQLite book; the extension caches each connected API separately. Normal use requires no Node installation or application build.

## Run on your laptop

Use Python 3.10+ and [uv](https://docs.astral.sh/uv/getting-started/installation/):

```sh
git clone https://github.com/wavey0x/0xlabel.git
cd 0xlabel
uv run 0xlabel
```

The first run creates `~/.local/share/0xlabel/labels.sqlite3` and a random access token in `token.txt`. The helper listens on `http://127.0.0.1:8712`. Leave it running or start the same command through your operating system's login-service facility.

Without uv:

```sh
python3 -m venv .venv
.venv/bin/pip install .
.venv/bin/0xlabel
```

On Windows, use `.venv\Scripts\pip` and `.venv\Scripts\0xlabel`.

## Load the extension

Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's **extension** folder. Do not load the repository root. Chrome 120 or newer is required. Pin 0xlabel to the toolbar.

In **Connections**, paste the JSON printed by the helper, name it **Local**, and connect. Accept the browser's permission request. That JSON contains your access token; keep it private.

Open a supported website, then turn on the popup's **Show my labels on this site** switch. The toolbar turns green when labeling is active. Permissions are granted per website; other sites remain untouched.

Click a blue tag beside an address to edit its names. The first name is the default; + appends an alias and arrows reorder them. Enter saves; Escape or an outside click dismisses the draft. The eye temporarily reveals the website's original presentation, while the per-site switch restores every website default.

New inline labels apply globally. Editing an existing network override retains its scope. The popup's optional chain ID can create a scoped list explicitly; removing that override reveals the global names. The eye suppresses the whole replacement until restored or reset by refresh, navigation, or switching books.

## Connect to a remote API

Run the same helper on your remote machine, behind an HTTPS reverse proxy:

```sh
uv run 0xlabel --public-url https://labels.example.com
```

For example, configure Caddy to forward to the helper's loopback listener:

```caddyfile
labels.example.com {
    reverse_proxy 127.0.0.1:8712
}
```

Use a reachable hostname and valid certificate. If serving under a path, pass the full base URL to `--public-url` and strip that path at the proxy. Requests reject redirects, so use the API's final URL.

Add the remote connection JSON in the popup and name it **Remote**. Each full API URL, including its port and path, owns a separate cache. **Selecting Remote never overwrites Local's database or cache.** Switching back displays Local's retained book and refreshes it. The laptop helper can stop while you use Remote.

Sync is a read-only snapshot pull, about once a minute while the browser runs, plus startup, selection, browsing resume, and manual refresh. Failed pulls keep the previous cache. An explicit save is the only operation that changes a book; saving needs a reachable API. Conflicting or failed saves preserve the draft.

## Data and backups

Choose a different port or data directory:

```sh
uv run 0xlabel --port 8713 --data-dir /path/to/book
```

`OXLABEL_DATA_DIR` sets the directory, and `OXLABEL_TOKEN` supplies a token instead of `token.txt`. Restart the helper after changing its token and update that connection in the popup. Keep credentials and books outside the checkout.

**Export this book** downloads the selected book's records without credentials. For a complete server backup, stop the helper and copy `labels.sqlite3` and `token.txt`. Restore them to that installation's data directory before restarting. Switching APIs does not transfer or merge data.

## Updates and privacy

This is an unpacked development extension. After editing or pulling its code, reload 0xlabel on the extensions page and refresh enabled websites. Restart the helper when its Python code changes. Address-book sync is independent of code reloads.

Displayed labels are part of the website's DOM and readable by that website. Credentials remain in trusted extension storage. Etherscan-family explorers and Safe have dedicated adapters; other enabled sites use full-address detection. Inputs, signing controls, and unresolved abbreviations are skipped. Inconsistent address evidence pauses labeling and offers Retry in the popup.

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

`npm run screenshots` reproduces the README examples using sample data and the actual extension. `npm run icons` regenerates toolbar assets after editing `extension/icons/book.svg`.

The app is in active development. Prefer hard cutovers over migrations and compatibility layers; see [AGENTS.md](AGENTS.md).
