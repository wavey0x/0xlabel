<h1 align="center">0xlabel</h1>
<p align="center"><strong>Your addresses. Familiar names.</strong><br>A small, self-hosted address book that brings your labels into the websites you use.</p>
<p align="center"><a href="#get-started">Get started</a> · <a href="INSTALL.md">Setup guide</a> · <a href="docs/architecture.md">How it works</a> · <a href="LICENSE">MIT</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/transfers-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/transfers-light.png">
  <img alt="A transfer list with recognizable labels such as Treasury, Payroll and Cold storage instead of abbreviated wallet addresses" src="docs/images/transfers-dark.png">
</picture>

Name a treasury, an exchange deposit, or a wallet you keep coming back to. Your labels replace the site's address or preset name, while its links and copy controls keep working.

- **Right there.** Edit names directly beside an address. Ranked aliases, checksummed copying, and a compact inline editor.
- **Your laptop or your server.** Python, SQLite, and an authenticated API. Local and remote books stay separate.
- **Fast by default.** Cached lookups handle hundreds of addresses. A simple periodic pull keeps the selected book fresh.
- **Easy to compare.** The eye reveals the website's original display. A per-site switch restores all website defaults.

Works with Etherscan-family explorers and Safe. Other enabled sites use conservative detection for full EVM addresses.

### Get started

With Python 3.10+ and [uv](https://docs.astral.sh/uv/getting-started/installation/):

```sh
git clone https://github.com/wavey0x/0xlabel.git
cd 0xlabel
uv run 0xlabel
```

1. Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, and **Load unpacked** → this project's `extension` folder.
2. Open 0xlabel. Paste the helper's connection JSON into **Connections**, then connect.
3. Enable the website in the popup. Click a blue tag beside an address to name it.

![The real inline editor, with a sample label being entered beside a transfer](docs/images/editor.png)

<sub>Screenshots use an explorer-style demo and sample data, rendered by the actual extension.</sub>

### Small by design

One Python process, one SQLite table, and a plain JavaScript extension. No application build step. Cached labels remain available when the API is offline; saving needs a connection.

Your book stays on the API you choose. **Websites can read labels displayed in their DOM.** API credentials stay in trusted extension storage and never reach content scripts.

Early development; installed as an unpacked extension. See the [setup guide](INSTALL.md) for remote hosting, backups, and code reloads, or [contributing](CONTRIBUTING.md) for development checks.
