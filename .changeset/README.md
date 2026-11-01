# Changesets

This directory holds pending release notes for the public `packages/*`
packages, managed by [Changesets](https://github.com/changesets/changesets).

1. After changing a public package, run `vp exec changeset`, select the
   affected packages and the semver bump, and write a short summary.
2. Commit the generated `.changeset/*.md` file with your change.
3. On push to `main`, `.github/workflows/release.yml` runs `vp run ready` and
   then `changesets/action`:
   - with pending changesets, it opens or updates a "Version Packages" PR that
     bumps versions and writes changelogs;
   - after that PR is merged, it publishes the bumped packages to npm using the
     `NPM_TOKEN` repository secret.

`@codemirror-treesitter/opendal-wasm-browser` and every `apps/*` workspace are
private and ignored (see `config.json`).
