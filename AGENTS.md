# Development policy

This is a greenfield app in active development: prefer breaking changes and hard cutovers; delete obsolete paths rather than adding release-version machinery, migrations, legacy formats, or backward-compatibility layers.

Keep mandatory package and Chrome manifest versions fixed at `1` during development; do not bump them for edits.

Keep tests focused on address identity, data integrity, credential boundaries, and native website behavior. Avoid pixel positioning, animation timing, screenshots, and rendering-mechanic assertions in the regression suite; screenshot generation is a separate demo task.

Use heavy minimalism: bold system type, compact aligned controls, quiet light/dark surfaces, and restrained royal-blue accents.
