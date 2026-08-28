# 0004 - SQLite plus files on disk for bundles

**Status:** accepted, 2026-08-28

## Decision

Bundle metadata goes in a SQLite file. PNGs go beside it on disk. The bundle's device
generated `sessionID` is the primary key, which makes an upload idempotent for free.

## Why

`docs/intake.md` lists four requirements. SQLite satisfies three of them with no server:

| Requirement | How |
|---|---|
| safe to retry | `INSERT OR IGNORE` on the device-generated id |
| ack marks it drained | one nullable `acked_at` column |
| retention | one `DELETE` on `acked_at` older than N days |

Postgres would satisfy them too, and also require a server to be running before anyone can
annotate anything.

## Rejected

- **Plain files only.** "List everything undrained, oldest first" becomes a directory scan
  and a parse of every file. Works at ten bundles, not at ten thousand.
- **Postgres.** The right answer when intake becomes multi-instance. Not before.

## Consequences

Intake is single-writer, so it runs on one box or one container with a volume. That is the
known ceiling. The upgrade path is a `Store` swap, and it is marked in the code.
