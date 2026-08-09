# Dependency Patches

`pingora-core+0.8.1.patch` adds opt-in reuse support for Pingora virtual L4
streams and enables programmatic shutdown on Windows. The patch is applied to
the pinned upstream crate source before Cargo builds the project.

## Current patch features

- **Virtual L4 stream reuse** — virtual transports (e.g. virtual JS sockets)
  can opt in to the connection reuse pool: `VirtualSocketStream::is_reusable`
  defaults to `false`, and the pool only retains a virtual stream when its
  transport explicitly permits it (`Stream::reuse_permitted` /
  `Peer::matches_stream`).
- **Unix socket reuse comparison fix** — `getpeername()` returns the peer
  path as it appears in the fixed-size `sun_path` buffer; the remainder of
  the buffer is zero-padded, so a short pathname comes back followed by
  **multiple** trailing NUL bytes (not just one). See
  [unix(7) — Linux manual page](https://man7.org/linux/man-pages/man7/unix.7.html),
  "Pathname sockets" / BUGS. The `ConnFdReusable for Path` comparison now
  trims all trailing NUL bytes, so previously mismatched sockets are
  correctly recognized as reusable.
- **Windows shutdown signal** — Windows has no OS-level `SIGTERM`. The default
  `ShutdownSignalWatch` waits forever (Ctrl+C drives shutdown through
  `main_loop`), and `RunArgs` on Windows accepts a programmatic
  `ShutdownSignalWatch` so the host process can stop the server.

Run:

```sh
npm run prepare:rust-patches
```

The helper first reuses `pingora-core-0.8.1.crate` from Cargo's local cache.
If it is unavailable, it downloads the archive from crates.io into
`target/patch-cache/`. It always verifies the pinned archive SHA-256 before
extracting, applying the patch, and writing a marker that records the archive
and patch checksums.

## Layout

`prepare:rust-patches` keeps two git repositories under `target/patch/`:

- `pingora-core-0.8.1/` — the **patched** source Cargo actually builds from.
  Its `HEAD` commit is the pristine (unpatched) crate, so `git diff` against
  the working tree is always the cumulative patch.
- `pingora-core-0.8.1-pristine/` — the **pristine** source, committed as-is,
  for reference and diffing.

## Updating a patch

1. Edit files under `target/patch/pingora-core-0.8.1/`.
2. Regenerate the patch from that tree:

   ```sh
   git -C target/patch/pingora-core-0.8.1 diff > patches/pingora-core+0.8.1.patch
   ```

3. Re-run `npm run prepare:rust-patches` so `target/patch/` is rebuilt from the
   new patch, then confirm the rebuild matches your edits:

   ```sh
   git -C target/patch/pingora-core-0.8.1 diff --stat   # should equal the patch file
   ```

> After upgrading this script itself, delete `target/patch/` once so the new
> layout (pristine tree + git history) is rebuilt.

## Upgrading Pingora

1. Update the pinned archive checksum in
   `scripts/prepare-rust-patches.mjs`.
2. Rebase or recreate the patch against the new source (see above).
3. Update the `[patch.crates-io]` path and patch filename in `Cargo.toml` and
   `scripts/prepare-rust-patches.mjs`.
4. Run debug and release virtual_js lifecycle/reuse tests.
