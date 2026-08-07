# Dependency Patches

`pingora-core+0.8.1.patch` adds opt-in reuse support for Pingora virtual L4
streams. The patch is applied to the pinned upstream crate source before Cargo
builds the project.

Run:

```sh
npm run prepare:rust-patches
```

The helper first reuses `pingora-core-0.8.1.crate` from Cargo's local cache.
If it is unavailable, it downloads the archive from crates.io into
`target/patch-cache/`. It always verifies the pinned archive SHA-256 before
extracting into `target/patch/`, applying the patch, and writing a marker that
records the archive and patch checksums.

When upgrading Pingora:

1. Update the pinned archive checksum in
   `scripts/prepare-rust-patches.mjs`.
2. Rebase or recreate the patch against the new source.
3. Update the `[patch.crates-io]` path and patch filename in `Cargo.toml` and
   `scripts/prepare-rust-patches.mjs`.
4. Run debug and release virtual_js lifecycle/reuse tests.
