# Ecosystem-table additions for the sibling repos (for t1r — not committed)

The row to add (same columns as every sibling's "The xtandard ecosystem" table; run the repo's
formatter afterwards — oxfmt / prettier re-align the columns):

```md
| **`@xtandard/entitlements`** | An embeddable entitlements, plans and usage-metering engine: a typed catalog in code, atomic metering, any billing provider and storage, with an admin UI and a customer portal | [Docs](https://me.xantiagoma.com/xtandard-entitlements/) · [GitHub](https://github.com/xantiagoma/xtandard-entitlements) · [npm](https://www.npmjs.com/package/@xtandard/entitlements) |
```

Where, per repo (insert right after the `@xtandard/webhooks` row, before `@xtandard/xyte` / `xtandard-image`):

| Repo                       | File        | After line                                                                                                                                                                               |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------- |
| xtandard (`@xtandard/lib`) | `README.md` | 966 (`@xtandard/webhooks` row)                                                                                                                                                           |
| xtandard-flags             | `README.md` | 449 (`@xtandard/webhooks` row)                                                                                                                                                           |
| xtandard-webhooks          | `README.md` | 328 is its own row; insert after the `@xtandard/flags` row (the table lists itself first)                                                                                                |
| xtandard-image             | `README.md` | 193 (`@xtandard/webhooks` row) — this table uses compact `                                                                                                                               | --- | ` columns, so keep the row unpadded |
| xyte                       | —           | **No ecosystem section yet.** Add the whole section (copy the table from `@xtandard/entitlements`' README, mark xyte "(this package)" and drop the entitlements "(this package)" marker) |

Also worth adding to each sibling's docs site `site/content/index.mdx` / ecosystem page if it lists the
family (flags and webhooks render the README section on `/project/ecosystem/`, so the README edit
covers them).
