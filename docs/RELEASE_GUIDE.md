# Formic Release Guide

This guide explains the complete release process for a non-technical maintainer, starting with merging completed work and ending with verified releases on:

- GitHub Releases
- npm (`@rickywo/formic`)
- GitHub Container Registry (`ghcr.io/rickywo/formic`)

The repository automatically publishes npm and Docker releases through `.github/workflows/release.yml` when a version tag such as `v0.9.0` is pushed. During a normal release, do **not** run `npm publish` or `docker push` manually.

The examples below release version `0.9.0`. Replace `0.9.0` everywhere if you are releasing another version.

---

## 1. Understand the version number

Formic uses versions in this format:

```text
MAJOR.MINOR.PATCH
```

Examples:

- `0.8.0` → `0.8.1`: small fixes only
- `0.8.0` → `0.9.0`: new features or meaningful improvements
- `0.9.0` → `1.0.0`: a major stable release or breaking changes

Set the version you intend to release:

```bash
export VERSION=0.9.0
export TAG=v0.9.0
```

Confirm the values:

```bash
echo "$VERSION"
echo "$TAG"
```

Expected output:

```text
0.9.0
v0.9.0
```

The Git tag includes a `v`. The version inside `package.json` does not.

---

## 2. Complete the one-time release setup

You only need to complete this section once.

### 2.1 Check your accounts and software

You need:

- Access to the `rickywo/Formic` GitHub repository
- Permission to merge pull requests
- An npm account allowed to publish `@rickywo/formic`
- GitHub CLI installed and authenticated
- Docker installed if you want to test images locally
- Node.js 20 or later — but the release workflow and both Dockerfiles use **Node.js 22**. Install Node.js 22 locally so your build and test results match CI exactly.
- `ripgrep` (the `rg` command), used by the version-search steps in section 5. Install it with `brew install ripgrep` (macOS) or `sudo apt-get install ripgrep` (Debian/Ubuntu). If you cannot install it, every `rg` command below has a `grep` fallback noted inline.

Check the installed tools:

```bash
node --version
npm --version
git --version
gh --version
docker --version
rg --version
```

`node --version` should print `v22.x` (or at minimum `v20.x`).

Check GitHub authentication:

```bash
gh auth status
```

If you are not logged in:

```bash
gh auth login
```

### 2.2 Check the GitHub Actions secrets

Open:

```text
https://github.com/rickywo/Formic/settings/secrets/actions
```

Confirm these repository secrets exist:

- `NPM_TOKEN`: an npm automation or granular token allowed to publish `@rickywo/formic`
- `REGISTRY_TOKEN`: a GitHub personal access token with at least `write:packages`

The registry token may also require `read:packages` and `repo` when private resources are involved.

Never paste either token into a source file, terminal command stored in Git, pull request, issue, or release note.

### 2.3 Check the npm release environment

Open:

```text
https://github.com/rickywo/Formic/settings/environments
```

Confirm an environment named `npm-release` exists. If it requires manual approval, you must approve the deployment after the release workflow starts.

---

## 3. Merge the completed feature PR

Before merging, confirm:

- The implementation is complete
- Automated checks are green
- The pull request has been reviewed
- No review comments remain unresolved
- The branch is up to date with `main`

Inspect your pull requests:

```bash
gh pr status
```

Inspect a specific pull request:

```bash
gh pr view PR_NUMBER
gh pr checks PR_NUMBER
```

Replace `PR_NUMBER` with the actual number, for example `112`.

The simplest option is to merge through the GitHub website. Alternatively:

```bash
gh pr merge PR_NUMBER --squash --delete-branch
```

Do not continue until GitHub confirms the pull request is merged.

---

## 4. Prepare a release PR

Do not tag the feature commit immediately. First create a small release-preparation PR containing the version and documentation updates.

### 4.1 Open the repository

```bash
cd /Users/rickywo/WebstormProjects/Formic-0.9
```

### 4.2 Protect unfinished local work

```bash
git status
```

If modified or untracked files appear, stop and identify them. Do not delete or overwrite somebody else's work.

If the changes are unfinished and need to be saved temporarily:

```bash
git stash push -u -m "Temporary work before release preparation"
```

### 4.3 Update your local main branch

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git status
```

`git status` should say:

```text
nothing to commit, working tree clean
```

### 4.4 Create a release branch

```bash
git switch -c release/v0.9.0
git branch --show-current
```

Expected branch:

```text
release/v0.9.0
```

---

## 5. Update every release version

### 5.1 Update package.json and package-lock.json

Run:

```bash
npm version 0.9.0 --no-git-tag-version
```

This updates both `package.json` and `package-lock.json` without creating a Git commit or tag.

Verify all three stored values:

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
node -p "require('./package-lock.json').packages[''].version"
```

All three must print:

```text
0.9.0
```

Do not update only `package.json`. The lock file must agree with it.

### 5.2 Update the runtime Dockerfile

In `Dockerfile`, change:

```dockerfile
ARG FORMIC_VERSION=0.8.0
```

To:

```dockerfile
ARG FORMIC_VERSION=0.9.0
```

### 5.3 Update the dev-container Dockerfile

In `Dockerfile.devcontainer`, make the same change:

```dockerfile
ARG FORMIC_VERSION=0.9.0
```

### 5.4 Update Docker Compose

In `docker-compose.yml`, change the Formic image to:

```yaml
image: ghcr.io/rickywo/formic:0.9.0
```

### 5.5 Update README.md

Update Formic release references in `README.md`, including:

- The npm badge
- Runtime image table
- Dev-container image table
- `docker run` examples
- The “What’s New” version and release notes

Find old references:

```bash
rg -n "0\\.8\\.0|v0\\.8\\.0" README.md
```

If you do not have `ripgrep`, use `grep` instead:

```bash
grep -nE "0\.8\.0|v0\.8\.0" README.md
```

Do not change unrelated dependency versions such as:

```text
xterm-addon-fit@0.8.0
```

That is a third-party library version, not the Formic version.

### 5.6 Search for forgotten old versions

```bash
rg -n "0\\.8\\.0|v0\\.8\\.0" \
  package.json \
  package-lock.json \
  README.md \
  Dockerfile \
  Dockerfile.devcontainer \
  docker-compose.yml
```

Without `ripgrep`, use `grep`:

```bash
grep -nE "0\.8\.0|v0\.8\.0" \
  package.json \
  package-lock.json \
  README.md \
  Dockerfile \
  Dockerfile.devcontainer \
  docker-compose.yml
```

Review every result. Historical release documentation may keep old versions where appropriate.

### 5.7 Add an in-repo release notes file

Formic keeps a release notes file per version in the repository root
(`RELEASE_NOTES_v0.7.3.md` and earlier). Create one for this release so the
history stays complete:

```bash
cp RELEASE_NOTES_v0.7.3.md RELEASE_NOTES_v0.9.0.md
```

Edit `RELEASE_NOTES_v0.9.0.md` to describe this version's changes. You will
reuse this content for the GitHub Release page in section 10. Include this file
in the release-preparation commit in section 7.2.

---

## 6. Test the release before committing

Every command in this section must succeed.

### 6.1 Install the locked dependencies

```bash
npm ci
```

If npm reports root-owned cache files, repair the cache ownership once:

```bash
sudo chown -R "$(id -u)":"$(id -g)" "$HOME/.npm"
```

Then rerun:

```bash
npm ci
```

### 6.2 Build Formic

```bash
npm run build
```

### 6.3 Run unit tests

```bash
npm test
```

> **Do not skip this.** The automated release workflow does **not** run the unit
> test suite — it only gates on secret scanning and the tarball audit. This
> local `npm test` is the *only* thing standing between a broken build and a
> published npm version, and npm versions cannot be overwritten once published.
> Every test must pass (the final line should report `fail 0`) before you
> continue. If any test fails, stop and fix it before releasing.

### 6.4 Audit the npm package

```bash
node scripts/auditNpmPack.mjs
```

The final output should report that all files are within the allowlisted roots.

Preview the package contents directly:

```bash
npm pack --dry-run
```

Confirm no secrets, local configuration, task data, or unrelated files are included.

### 6.5 Check the CLI version

```bash
node dist/cli/index.js --version
```

The output must include `0.9.0`.

### 6.6 Validate Docker Compose

Because Compose requires credentials, use harmless temporary values while validating its structure:

```bash
FORMIC_AUTH_TOKEN=release-validation \
ANTHROPIC_API_KEY=release-validation \
docker compose config
```

### 6.7 Build the runtime image locally

```bash
docker build \
  --build-arg FORMIC_VERSION=0.9.0 \
  -t formic-release-test:0.9.0 \
  .
```

Check its version label:

```bash
docker inspect formic-release-test:0.9.0 \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
```

Expected output:

```text
0.9.0
```

Remove the local test image if desired:

```bash
docker image rm formic-release-test:0.9.0
```

The new dev-container cannot be fully built until the new Formic version exists on npm. The GitHub workflow publishes npm first, waits for registry propagation, and then builds the dev-container automatically.

---

## 7. Create and merge the release PR

### 7.1 Review the changes

```bash
git status
git diff
```

The normal release files are:

```text
package.json
package-lock.json
README.md
Dockerfile
Dockerfile.devcontainer
docker-compose.yml
RELEASE_NOTES_v0.9.0.md
```

Do not include unrelated files.

### 7.2 Stage and commit the release

```bash
git add \
  package.json \
  package-lock.json \
  README.md \
  Dockerfile \
  Dockerfile.devcontainer \
  docker-compose.yml \
  RELEASE_NOTES_v0.9.0.md
```

Review the staged changes:

```bash
git diff --cached
```

Commit them:

```bash
git commit -m "Prepare release v0.9.0"
```

### 7.3 Push the branch

```bash
git push -u origin release/v0.9.0
```

### 7.4 Create the release PR

```bash
gh pr create \
  --base main \
  --head release/v0.9.0 \
  --title "Prepare release v0.9.0" \
  --body "## Release preparation

- Update package version to 0.9.0
- Update package-lock version
- Update Docker runtime and dev-container versions
- Update Docker Compose image
- Update README version references and release notes

## Validation

- [x] npm ci
- [x] npm run build
- [x] npm test
- [x] node scripts/auditNpmPack.mjs
- [x] Docker Compose configuration validated
- [x] Runtime Docker image built locally"
```

### 7.5 Wait for checks and merge

```bash
gh pr checks --watch
```

Do not merge while a required check is failing.

Merge through the GitHub website, or run:

```bash
gh pr merge --squash --delete-branch
```

---

## 8. Create the release tag

Pushing the tag is the action that starts npm and Docker publishing.

### 8.1 Update main again

```bash
git switch main
git pull --ff-only origin main
git status
```

The working directory must be clean.

### 8.2 Confirm the merged versions

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
node -p "require('./package-lock.json').packages[''].version"
```

All three must print `0.9.0`.

### 8.3 Confirm the tag does not exist

```bash
git tag --list v0.9.0
git ls-remote --tags origin v0.9.0
```

Both commands should return nothing. If the tag exists, stop. Never reuse a published version.

### 8.4 Create and inspect the tag

> The workflow's first job (`validate-release`) fails immediately if the tag
> version does not exactly match the `version` field in `package.json`. Because
> you release `v0.9.0`, `package.json` must contain `0.9.0` (confirmed in
> section 8.2). The tag carries the `v` prefix; `package.json` does not.

```bash
git tag -a v0.9.0 -m "Release v0.9.0"
git show v0.9.0 --no-patch
```

### 8.5 Push the tag

```bash
git push origin v0.9.0
```

Do not run `npm publish` or `docker push`. GitHub Actions now handles both.

---

## 9. Monitor automated publishing

List recent release runs:

```bash
gh run list --workflow release.yml --limit 5
```

Watch the release:

```bash
gh run watch --exit-status
```

If prompted, select the run for `v0.9.0`.

Open the run in a browser if needed:

```bash
gh run view --web
```

The workflow performs:

1. Tag and `package.json` version validation
2. Full-history secret scanning
3. npm tarball allowlist auditing
4. npm publishing with provenance
5. Runtime Dockerfile linting and image building
6. HIGH and CRITICAL vulnerability scanning before push
7. Runtime Docker publishing
8. npm registry propagation checks
9. Dev-container linting, building, and vulnerability scanning
10. Dev-container publishing

Expected npm package:

```text
@rickywo/formic@0.9.0
```

Expected runtime Docker tags:

```text
ghcr.io/rickywo/formic:0.9.0
ghcr.io/rickywo/formic:0.9
ghcr.io/rickywo/formic:latest
```

Expected dev-container tag:

```text
ghcr.io/rickywo/formic:0.9.0-devcontainer
```

The current workflow builds `linux/amd64`, not a multi-platform image.

---

## 10. Create the GitHub Release page

The workflow publishes npm and Docker artifacts but does not create a GitHub Release page.

Only continue after the complete release workflow succeeds.

### 10.1 Write release notes

```bash
nano /tmp/formic-v0.9.0-notes.md
```

Example:

````markdown
## What's new

- Describe the most important new feature.
- Describe important fixes.
- Describe meaningful user-facing changes.

## Install

```bash
npm install -g @rickywo/formic@0.9.0
```

## Docker runtime

```bash
docker pull ghcr.io/rickywo/formic:0.9.0
```

## Dev container

```bash
docker pull ghcr.io/rickywo/formic:0.9.0-devcontainer
```
````

Save and close the editor.

### 10.2 Publish the GitHub Release

```bash
gh release create v0.9.0 \
  --title "Formic v0.9.0" \
  --notes-file /tmp/formic-v0.9.0-notes.md \
  --verify-tag
```

Verify it:

```bash
gh release view v0.9.0
```

---

## 11. Verify npm

Confirm the version exists:

```bash
npm view @rickywo/formic@0.9.0 version
```

Expected output:

```text
0.9.0
```

Confirm `latest` points to the new version:

```bash
npm view @rickywo/formic dist-tags
```

Test the published CLI without changing your global installation:

```bash
npx --yes @rickywo/formic@0.9.0 --version
```

Optional global installation test:

```bash
npm install -g @rickywo/formic@0.9.0
formic --version
```

---

## 12. Verify the Docker images

### 12.0 First release only: make the GHCR packages public

**The very first time an image is pushed, GitHub creates the GHCR package as
private.** A private package cannot be pulled by other people (or by an
unauthenticated `docker pull`), so the verification commands below will fail
with a `denied` / `not found` error until you change the visibility. You only
need to do this once per package — later releases inherit the setting.

All tags — `0.9.0`, `0.9`, `latest`, and `0.9.0-devcontainer` — live under a
single GHCR package named `formic`, so you only change visibility once:

1. Open your packages list:

   ```text
   https://github.com/users/rickywo/packages
   ```

2. Click the `formic` container package.
3. Open **Package settings** (right-hand side).
4. Under **Danger Zone → Change visibility**, set it to **Public** and confirm.
5. Under **Manage Actions access** (or **Repository access**), confirm the
   `rickywo/Formic` repository is linked so future workflow runs can push.

If you are logged in to GHCR locally (`docker login ghcr.io`), a private image
will still pull for *you* — always test the visibility from an incognito
context or ask someone else to pull, or run `docker logout ghcr.io` first.

### 12.1 Verify the runtime image

```bash
docker pull ghcr.io/rickywo/formic:0.9.0
docker inspect ghcr.io/rickywo/formic:0.9.0 \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
```

The label must print `0.9.0`.

Pull the floating runtime tags:

```bash
docker pull ghcr.io/rickywo/formic:0.9
docker pull ghcr.io/rickywo/formic:latest
```

### 12.2 Verify the dev-container

```bash
docker pull ghcr.io/rickywo/formic:0.9.0-devcontainer
docker run --rm \
  ghcr.io/rickywo/formic:0.9.0-devcontainer \
  formic --version
```

The output must include `0.9.0`.

### 12.3 Smoke-test the runtime server

Create a temporary workspace and token:

```bash
mkdir -p /tmp/formic-release-workspace
export FORMIC_AUTH_TOKEN="temporary-release-test-token"
```

Start the container:

```bash
docker run --rm -d \
  --name formic-release-test \
  -p 8001:8000 \
  -e HOST=0.0.0.0 \
  -e FORMIC_AUTH_TOKEN="$FORMIC_AUTH_TOKEN" \
  -v /tmp/formic-release-workspace:/app/workspace \
  ghcr.io/rickywo/formic:0.9.0
```

Inspect it:

```bash
docker ps --filter name=formic-release-test
docker logs formic-release-test
```

Check its health endpoint. `/api/health` is deliberately exempt from
authentication (it is the Docker health-check target and returns no sensitive
data), so **no** token is needed and it should return `{"status":"ok"}`:

```bash
curl http://localhost:8001/api/health
```

Now confirm authentication is actually enforced on the real API. Without a
token, `/api/board` must return `401 Unauthorized`:

```bash
curl -o /dev/null -w "%{http_code}\n" http://localhost:8001/api/board
```

With the correct token, the same endpoint returns `200`:

```bash
curl -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $FORMIC_AUTH_TOKEN" \
  http://localhost:8001/api/board
```

Stop it:

```bash
docker stop formic-release-test
```

---

## 13. Final release checklist

The release is complete only when every applicable item is checked:

- [ ] Completed feature PR is merged
- [ ] Release-preparation PR is merged
- [ ] `package.json` contains `0.9.0`
- [ ] Both package-lock version fields contain `0.9.0`
- [ ] Both Dockerfiles use `FORMIC_VERSION=0.9.0`
- [ ] Docker Compose uses `ghcr.io/rickywo/formic:0.9.0`
- [ ] README release references and notes are updated
- [ ] `RELEASE_NOTES_v0.9.0.md` added to the repository
- [ ] `npm run build` passes
- [ ] `npm test` passes locally (CI does **not** run it)
- [ ] npm tarball audit passes
- [ ] Tag `v0.9.0` points to the merged release commit on `main`
- [ ] GitHub release workflow is completely green
- [ ] npm reports `@rickywo/formic@0.9.0`
- [ ] npm `latest` points to `0.9.0`
- [ ] Runtime images `0.9.0`, `0.9`, and `latest` exist
- [ ] Dev-container image `0.9.0-devcontainer` exists
- [ ] GHCR package visibility is **Public** (first release only)
- [ ] GitHub Release page exists
- [ ] Published CLI works
- [ ] Runtime container health check succeeds

---

## 14. If the automated release fails

Find the run:

```bash
gh run list --workflow release.yml --limit 5
```

View its details:

```bash
gh run view RUN_ID
```

Replace `RUN_ID` with the number shown by the previous command.

Rerun only failed jobs:

```bash
gh run rerun RUN_ID --failed
gh run watch RUN_ID --exit-status
```

### The Docker job failed on a Trivy vulnerability scan

The `docker` and `devcontainer` jobs build the image, scan it with Trivy, and
push **only if the scan is clean**. The scan fails the job on any `HIGH` or
`CRITICAL` finding, and it is configured with `ignore-unfixed: false`, so it
also fails on vulnerabilities that have **no fix available yet** — these come
from the `node:22` base image, not from Formic's own code, and there may be
nothing you can directly patch.

If a release is blocked this way:

1. Read the Trivy output in the failed job log to see which package and CVE
   triggered it, and whether a fixed version exists.
2. If a fix exists, bump the base image. Pull the latest digest and update the
   `FROM node:22-slim@sha256:...` line in `Dockerfile` (and the
   `node:22-bookworm` line in `Dockerfile.devcontainer`):

   ```bash
   docker pull node:22-slim
   docker inspect node:22-slim --format='{{ index .RepoDigests 0 }}'
   ```

   Commit the new digest via a patch release and re-tag.
3. If the finding is **unfixable** (no upstream patch) and you accept the risk,
   either add a Trivy ignore entry for that specific CVE (a `.trivyignore`
   file listing the CVE ID) or, as a last resort, set `ignore-unfixed: true`
   on the Trivy steps in `.github/workflows/release.yml`. Prefer the
   per-CVE `.trivyignore` so unrelated new vulnerabilities are still caught.
4. Because npm may already have published by the time the Docker job runs,
   fix the scan issue and **rerun only the failed jobs** (below) rather than
   cutting a new npm version — unless you also changed `Dockerfile`, which
   requires a new patch tag.

### npm succeeded but Docker failed

Do not create another npm release with the same version. Fix the Docker or workflow problem and rerun the failed jobs.

### A serious problem was found after publishing

npm versions cannot be overwritten. Prepare a corrective patch version, such as `0.9.1`.

If necessary, warn users away from the broken npm release:

```bash
npm deprecate @rickywo/formic@0.9.0 "Please upgrade to 0.9.1"
```

Do not delete or reuse the `v0.9.0` tag after npm or Docker artifacts have been published. Create a new patch release instead.

