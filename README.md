<h1 align="center">0xlabel</h1>
<p align="center"><strong>One private address book. A clearer view of the web.</strong><br>A single source of truth for your tags, overlaid on the websites you use.<br>Self-hosted on your laptop or server. No central service or account.</p>
<p align="center"><a href="#get-started">Get started</a> · <a href="INSTALL.md">Setup guide</a> · <a href="LICENSE">MIT</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/transfers-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/transfers-light.png">
  <img alt="A transfer list with recognizable labels such as Treasury, Payroll and Cold storage instead of abbreviated wallet addresses" src="docs/images/transfers-dark.png">
</picture>

Collect address tags in one book and bring the same context to different websites. See recurring addresses, follow connections, and make sense of onchain activity. Add tags directly on the page; links and copy controls keep working.

- **Easy to add.** Tag an address directly on the page with a compact inline editor.
- **One consistent view.** The same tags follow addresses across enabled websites. Open the full-page book to search, add, edit, or export them.
- **Your book, your storage.** Keep it on your laptop or connect to your own authenticated API. Local and remote books stay separate.
- **Fast by default.** Cached lookups handle hundreds of addresses. A simple periodic pull keeps the selected book fresh.
- **Easy to compare.** Matching switches control one address or a whole website. Reveal originals without changing your saved tags.

Works with Etherscan-family explorers and Safe. Other enabled sites use conservative detection for full EVM addresses.

### Privacy

Your SQLite book lives on your laptop or a server you control, behind an authenticated API. 0xlabel has no central service, accounts, or analytics. API credentials stay in trusted extension storage and never reach content scripts.

**Tags displayed on a website are readable by that website.** The extension keeps your stored book under your control; its on-page overlay is not hidden from the site.

### Get started

With Python 3.10+ and [uv](https://docs.astral.sh/uv/getting-started/installation/):

```sh
git clone https://github.com/wavey0x/0xlabel.git
cd 0xlabel
uv run 0xlabel
```

1. Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, and **Load unpacked** → this project's `extension` folder.
2. Open 0xlabel. Choose **Connect a book** → **Add connection**, paste the helper's JSON, then connect.
3. Enable the website in the popup. Click a blue tag beside an address to name it.

![The real inline editor, with a sample label being entered beside a transfer](docs/images/editor.png)

<sub>Screenshots use an explorer-style demo and sample data, rendered by the actual extension.</sub>

### Small by design

One Python process, one SQLite table, and a plain JavaScript extension. No application build step. Cached labels remain available when the API is offline; saving needs a connection.

Early development; installed as an unpacked extension. See the [setup guide](INSTALL.md) for remote hosting, backups, updates, and development checks.
