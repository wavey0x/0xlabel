# 0xlabel adapter contract

This is the implementation contract. The README remains the narrative version intended for reading aloud. The static registry is in `extension/adapters.js`; a copyable example appears below. Example code stays in this document and is not packaged with the extension.

An adapter reads a page and returns existing elements with verified address identities. The extension core owns every mutation, annotation, editor, cache, API call, and lifecycle. Ship adapters as ordinary extension modules in a static registry. A site adapter takes precedence over the generic detector; a stale site adapter falls back to native browsing.

The contract can be expressed with these types for documentation, while the implementation stays ordinary JavaScript with JSDoc.

```typescript
type Network = `eip155:${number}`;

type Context = {
  document: Document;
  url: URL;
};

type Health =
  | { status: "ready"; network?: Network }
  | { status: "waiting" }
  | { status: "unsupported" }
  | { status: "stale"; reason: string };

type Target = {
  element: HTMLElement;       // The existing address text or fragment element.
  address: string;            // Full 20-byte hexadecimal address; never abbreviated.
  network?: Network;         // Overrides the probe's network for this target.
};

type Adapter = {
  id: string;
  matches(url: URL): boolean;
  probe(context: Context): Health;
  scan(root: Document | Element, context: Context): Target[];
};
```

Omitted network means unknown, not Ethereum. The core validates network identifiers as positive integer EVM chain IDs, uses an explicit target network, then the probe network, then the global list only. Probes run before decorating, on route changes, and when relevant page structure changes. Batch mutations and allow the DOM to settle before confirming a structural failure. A recognized loading indicator can return waiting. A missing expected landmark gets a brief loading grace before being treated as stale. Zero targets alone never proves staleness; empty supported pages are healthy.

The scan root can be a complete document or one changed branch. The core passes the affected existing target host when a nested text node or identity attribute changes. The shared query helper includes a matching root as well as matching descendants. Adapter scans must be bounded, synchronous, and read-only, and must not throw just because an ordinary unknown fragment cannot be resolved. Expected site-specific structure that becomes contradictory or unparsable is a real adapter failure.

Etherscan names can appear in `.hash-tag` widgets or `data-highlight-value` address links, including homepage fee recipients. Both require a canonical full-address source. Tooltip text and nicknames never establish identity by themselves; navigation items remain excluded. The observer tracks changes to the highlight marker through the same changed-branch scan.

The core normalizes and validates full addresses, verifies connected elements, and deduplicates repeated claims. Reject inputs, textareas, contenteditable regions, signing buttons, and submit controls; read-only address summaries are eligible even inside a transaction view. Targets must be specific address elements, never whole table rows containing several identities. One element owns its marker, label, and edit control; there is no separate outline host or collision map. Adapters check contradictory full-address evidence and confirm that a displayed abbreviation agrees with its canonical source; an abbreviation is never sufficient identity evidence on its own. A changed or unresolvable identity clears the old annotation immediately. Labels and the editor always bind to the verified address and scope, never the displayed nickname or abbreviated fragment.

Shared helpers should have deliberately small behavior: `query(root, selector)` includes the root; `parseAddress(value)` accepts a complete hexadecimal address and returns its canonical lowercase form or null. Neither guesses from substrings or truncated values. This minimal example uses a fictional site and its explicit address-link route.

```javascript
import { query, parseAddress } from "./shared.js";

function read(host) {
  const element = host.querySelector("[data-address-text]");
  const link = host.querySelector("a[data-address-link]");
  if (!element || !link) return null;

  const path = new URL(link.href).pathname;
  const token = path.match(/^\/address\/([^/]+)\/?$/)?.[1];
  const address = parseAddress(token);
  if (!address) return null;

  const shown = element.textContent.trim().toLowerCase();
  const fullShown = parseAddress(shown);
  if (fullShown && fullShown !== address) return null;
  const short = shown.match(/^(0x[0-9a-f]+)[.\u2026]+([0-9a-f]+)$/);
  if (short && (!address.startsWith(short[1]) || !address.endsWith(short[2]))) return null;
  return { element, address };
}

export const exampleAdapter = {
  id: "example",
  matches: url => url.hostname === "example.invalid",

  probe({ document, url }) {
    if (url.pathname !== "/wallets") return { status: "unsupported" };
    if (document.readyState === "loading" || document.querySelector("[data-loading]")) {
      return { status: "waiting" };
    }

    const page = document.querySelector("main[data-wallets]");
    if (!page) return { status: "stale", reason: "wallets-landmark-missing" };

    const hosts = query(page, "[data-wallet]");
    const addressLinks = query(page, "a[data-address-link]");
    if ((addressLinks.length && !hosts.length) || hosts.some(host => !read(host))) {
      return { status: "stale", reason: "wallet-address-markup-changed" };
    }
    return { status: "ready", network: "eip155:1" };
  },

  scan(root) {
    return query(root, "[data-wallet]").map(host => {
      const target = read(host);
      if (!target) throw new Error("wallet-address-markup-changed");
      return target;
    });
  }
};
```

An author copies this example, replaces the site's matching and structural evidence, registers it, and adds fixtures. If the adapter lives in a separate imported module, add that file explicitly to the manifest's web-accessible resources. Shared helpers and ordinary fixture tests belong to the core. Exercise extraction, unchanged native text and links, recycled elements, and complete cleanup against saved HTML and fake label data. Reuse the actual renderer and editor in browser tests. There is no dedicated preview application, adapter framework, or additional service to build.

Use fixtures for a full address, a shortened fragment with a canonical link, an empty supported page, loading, an unsupported route, a missing landmark, changed address markup, and a reused row. Check real websites separately for layout, copying, modifier clicks, menus, accessibility, and long lists. Local diagnostic messages can include the adapter ID, health, target count, and fixed reason code. A custom inspector or debug dashboard is outside the baseline. Never send browsing data to the API.

Keep user-facing states consistent. Ready means normal labeling, including a valid empty page. Waiting and unsupported preserve normal browsing without an error badge. Stale, thrown exceptions, and contradictory identities remove the adapter's owned page decorations and show one amber warning for that tab. Retry performs a fresh probe, and only ready resumes labeling. Permission removal, route changes, and disabling trigger the same cleanup. Connection failures are separate and retain the selected connection's cached labels. If an editor is open during failure, preserve its captured record and draft independently of the paused target.

Connections and synchronization are core responsibilities, never adapter hooks. Namespace settings and caches in chrome.storage.local by normalized full API base URL, including port and base path; do not use Chrome account sync for credentials or books. Normalize equivalent trailing-slash and default-port forms, reject user information, query strings, and fragments in base URLs, and require HTTPS except for loopback connections. A changed base URL creates a separate saved entry. Request permission only for the configured API origin. One selected key chooses the visible book, and one Chrome alarm periodically downloads only that book. A validated full snapshot replaces only its own namespace; failed pulls retain the previous cache. No background process uploads snapshots or migrates data. Switching sources clears the old book's annotations, applies only the selected book, and leaves the other caches and databases intact. Adapters receive the chosen label map through the existing core path.

Requests capture their connection key and token, use a short timeout, and reject redirects. A small selection generation counter discards pull responses when selection or credentials changed, including switching away and back. Recheck the source before broadcasting a snapshot to pages; page updates also carry their connection key and selection generation so stale messages are ignored. Editors capture the connection key as well as address and scope. The worker rejects saves from an editor belonging to another selected connection and preserves its draft for switching back. An already-started write retains its original destination, never the new active API. Only explicit user saves can write server data. This adds a storage namespace and small source guards, not a merge protocol or a separate sync engine.

The core adds namespaced marker attributes, a shared stylesheet, its own UI, and an accessible `aria-description` when the page has none. Cleanup removes that description only if its value is still the one the core wrote. A labeled target captures its native font size in `--0xlabel-font-size`; CSS collapses the native text's visible glyphs and draws only the selected label, with no separator or duplicate name. Inline address elements become inline blocks so the label retains a real link hit area. Native text nodes, children, classes, style declarations, and link targets stay intact; cleanup removes the owned variable and marker to restore the original presentation. Skip target containers with native interactive descendants. It adds an owned inline label control after the canonical link or display element; plain block displays contain that small control so it stays on the address line. Its SVG adds no text to native copy sources, and a button never nests inside a native link. Cleanup is idempotent. An owned element set is enough; a DOM snapshot or mutation-reversal journal is unnecessary. No adapter intercepts wallet providers, overrides clipboard handling, runs fetches, or creates its own observers. If address evidence or native behavior cannot be preserved, leave that element alone.

The shared UI uses a quiet, always-visible twenty-pixel inline label control beside each verified address, and one compact branded editor for the page. Native copy and navigation controls remain separate. Label control styling is isolated in small shadow roots that share one stylesheet. Browser layout positions the controls; CSS handles hover and focus, without timers, geometry reads, or hit tests. Label controls enter the ordinary tab order after their address link, and the context-menu action remains available. The editor is positioned absolutely in the document: page scrolling needs no measurements or style updates. Opening, size changes, and viewport resize fit it into view; layout shifts and independently scrolling panels retain the chosen gap and side. A detached draft becomes fixed in view. Its captured identity and source remain independent of the row. Owned UI insertion/removal is ignored by the page observer, and reused verified targets retain their existing label controls. Cleanup removes every owned control.

The popup and shared editor follow the heavy minimalist direction in [style.md](style.md): heavy type, quiet monochrome surfaces, borderless controls, soft corners, and restrained royal-blue accents. Hover styling must not discard a verified identity; page-root tooltips should scan only their changed branch. Nested pointer transitions perform no label control positioning work.

The website editor's header eye temporarily reveals the native display for every matching address and chain on that page. One in-memory set in the page controller stores these comparisons, using the same address-and-network key as matching. Suppress the entire rendered replacement, including global fallback, while retaining address markers and tag controls. Reuse the existing paint path to remove the owned label, font variable, and description. Same-page mutations, sync, and saves preserve the comparison; URL navigation, book selection changes, or a new controller reset it. The eye reads current availability and visibility from the controller, and its action checks the captured book and identity against a connected target, ready integration, and current URL. Detached or source-switched drafts cannot toggle another row or book. Omit the eye when no saved override exists. Popup book editing keeps its close control and has no page visibility action. These comparisons require no storage fields, messages, or API changes.

The editor works on one draft ordered list. New names append, and move-up and move-down controls reorder them. The first name has the Default badge when there are several names. A separate Make default control and dragging are outside the baseline. Enter in a name field saves the whole list once, except while composing text; ranking buttons retain normal Enter and Space activation. Clicking outside or pressing Escape cancels; the popup also has a close control. Changes become page defaults after confirmation, subject to the temporary comparison above. An address-and-scope record stores the ordered list as JSON with one edit-conflict token, so renames and ranking changes use the same atomic write. Saving an empty list deletes that scoped record and reveals the global list, if applicable, or the original page display. Scope selection happens before ranking, with network override before global, and array index zero always determines the displayed name. The API needs only book download and one record-replacement operation; bulk import, separate alias endpoints, and history operations are unnecessary.

The backend, cache boundary, page controller, label control, shared editor, popup, and initial adapters are implemented. Ordinary tests exercise the real page controller and editor against fixtures, and load the installed extension against disposable HTTP and HTTPS books. See [test coverage](testing.md) for the evidence and remaining limits of live-site coverage.
