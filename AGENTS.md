# Development policy

This is a greenfield app in active development: prefer breaking changes and hard cutovers; delete obsolete paths rather than adding release-version machinery, migrations, legacy formats, or backward-compatibility layers.

Keep mandatory package and Chrome manifest versions fixed at `1` during development; do not bump them for edits.
