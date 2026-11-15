# github-core-clone

A standalone, GitHub-compatible git forge in one Node process, with no
dependencies and no outside service. It serves, from its own in-memory store:

- git smart HTTP (`/{owner}/{repo}.git`): upload-pack protocol v2 (plus a v0
  fallback), receive-pack v0 with report-status, side-band-64k and
  delete-refs, fast-forward enforcement per ref
- REST v3 (`/api/v3`): repositories, branches, commits, contents, issues,
  comments, labels and pull requests with squash merges
- GraphQL v4 (`/api/graphql`): the documents `gh` and `github-mcp-server`
  send, including introspection, Relay global ids and cursor pagination
- MCP (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) with a legacy `initialize` handshake fallback

## Running it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL`, serves until the harness reports done, then exits 0.
`$MAKEFUN_SHOP_TOKEN` is the bearer token the API surfaces accept; the
token's owner is the viewer the suite drives as.

## Layout

- `main.ts` — the entry/harness lifecycle: bind, register, wait for done
- `app.ts` — the HTTP server and routing
- `lib/store.ts` — the forge's store: repositories, refs, objects, issues,
  pull requests, merges and contents commits
- `lib/gitcore.ts` — git objects, packfiles and deltas, on `node:zlib` and
  `node:crypto` only
- `lib/pktline.ts` — pkt-line framing for the smart-HTTP protocols
- `lib/githttp.ts` — the smart-HTTP handlers (advertisements, ls-refs,
  fetch, receive-pack)
- `lib/rest.ts` — the REST v3 handlers
- `lib/graphql.ts` — a small GraphQL executor for the supported documents
- `lib/mcp.ts` — the MCP endpoint and its tools

Everything is deterministic: creation order comes from a sequence counter,
not the wall clock, so two runs over the same requests leave the same state.
