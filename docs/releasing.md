# Releasing

Every merge to `main` runs `.github/workflows/publish.yml`, which tests on Node 22 and 24, then
lets [semantic-release](https://semantic-release.gitbook.io) pick the version from conventional
commits and publish it to npm with trusted publishing (OIDC). Nothing is committed back: the version
lives in the git tag, on npm and in the GitHub Release. `package.json` stays at
`0.0.0-development`.

## The npm side

The workflow alone cannot publish; npm has to trust it. Without this, the run fails at
`npm publish` with:

```
npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/swaggerizer - OIDC permission denied for this action
```

On npmjs.com → `swaggerizer` → **Settings** → **Trusted Publisher**, the GitHub Actions entry must
match the workflow exactly:

| Field | Value |
| --- | --- |
| Organization or user | `jayjaybeeuk` |
| Repository | `swaggerizer` |
| Workflow filename | `publish.yml` — filename only, no `.github/workflows/` prefix |
| Environment name | empty; the release job sets none |
| Allowed actions | **Allow npm publish** ticked |

Trusted publishers created after 2026-09-03 allow only `npm stage publish` by default. A
stage-only publisher cannot drive this workflow — semantic-release runs a plain `npm publish`, and
staged releases would need a maintainer to approve every version by hand with 2FA. That default is
the usual cause of the 403 above.

If the configuration already allows `npm publish`, delete it and create it again: npm does not
re-verify a connection when it is saved, a connection that never completed a first publish within
two days expires, and connections cannot always be edited in place.

The equivalent from a terminal (npm 11.15+, needs your 2FA):

```bash
npm trust github swaggerizer --file publish.yml --allow-publish --yes
```

The token permission (`id-token: write`) and the npm trust must both be present. `npm` also only
uses OIDC when no registry token is configured, which is why the release job fails fast if
`NODE_AUTH_TOKEN` or `NPM_TOKEN` is set.

## Recovering from a failed publish

semantic-release creates the git tag in its `prepare` step, *before* `npm publish` runs. When the
publish fails, the tag exists but no version was released, and the next run sees no commits after
that tag and does nothing.

Fix the cause, then delete the orphaned tag and re-run the workflow:

```bash
git push --delete origin v1.0.1   # the tag from the failed run
git tag -d v1.0.1                 # if it exists locally
```

Confirm nothing reached npm before doing this (`npm view swaggerizer versions`); the tag can be
deleted safely only when that version is absent.

## Checking a release

```bash
npm view swaggerizer version dist-tags
gh release list
git fetch --tags && git tag --sort=-v:refname | head -3
```

A healthy run ends with a git tag, an entry on npm with provenance, and a GitHub Release whose notes
list the conventional commits since the previous tag.
