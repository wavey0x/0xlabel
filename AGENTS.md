# Development policy

This is a greenfield app in active development: prefer breaking changes and hard cutovers; delete obsolete paths rather than adding release-version machinery, migrations, legacy formats, or backward-compatibility layers.

Keep mandatory package and Chrome manifest versions fixed at `1` during development; do not bump them for edits.
Treat `minimum_chrome_version` as the feature floor; raise it deliberately if a required feature needs a newer Chrome.

Keep tests focused on address identity, data integrity, credential boundaries, and native website behavior. Avoid pixel positioning, animation timing, screenshots, and rendering-mechanic assertions in the regression suite; screenshot generation is a separate demo task. Two narrow paint checks may read screenshot ink from controlled fixtures: a site-owned icon stays on its row before and after annotation, and the same tag remains visible when a cell narrows. Each must be shown failing on the historical stylesheet it guards; neither uses a fixed page position or stored image as its expected result.

Keep site knowledge in `extension/adapters.js` beside the rule it explains. Where a site's shape is surprising enough to be hard to reconstruct, record the public page, date, and interaction needed to see it in a `seen:` comment.

When more than one agent works in this tree, stage explicit file paths; never use `git add -A` or stage a directory.

Use heavy minimalism: bold system type, compact aligned controls, quiet light/dark surfaces, and restrained deep-purple accents.
