#!/usr/bin/env bash
#
# Formic interactive release script
# =================================
# Publishes a Formic release from your local machine, pausing for interactive
# authentication (npm 2FA one-time password, Docker Hub login, GitHub CLI) at
# each step. Every publishing/pushing action is gated behind a yes/no prompt so
# you decide exactly what this script does versus what the CI workflow does.
#
# It publishes:
#   - npm package   @rickywo/formic@<version>
#   - Docker images docker.io/rickywo/formic:<version> | :<major.minor> | :latest
#                   docker.io/rickywo/formic:<version>-devcontainer
#   - git tag       v<version>  (+ optional GitHub Release page)
#
# The version comes from package.json — bump it (npm version <v> --no-git-tag-version)
# and merge that change before releasing. Usage:
#
#   ./scripts/release.sh            # release the version currently in package.json
#   DOCKER_IMAGE=you/formic ./scripts/release.sh   # override the image namespace
#
# NOTE ON CI COLLISION: this repository also has a tag-triggered CI workflow
# (.github/workflows/release.yml) that auto-publishes. If you publish with this
# script AND push the tag, the CI run will try to publish the same version and
# fail on "already exists". Use EITHER this script OR a tag push — not both. The
# per-step prompts below let you skip whatever CI will handle.
#
set -euo pipefail

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NPM_PKG="@rickywo/formic"
DOCKER_IMAGE="${DOCKER_IMAGE:-docker.io/rickywo/formic}"
NOTES_DIR="$REPO_ROOT"

# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD$CYAN" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '    %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn()  { printf '    %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
die()   { printf '\n%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# Ask a yes/no question. Returns 0 for yes, 1 for no. Defaults to no.
confirm() {
  local prompt="$1" reply
  printf '%s%s [y/N] %s' "$BOLD" "$prompt" "$RESET"
  read -r reply || reply=""
  case "$reply" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

# --------------------------------------------------------------------------
# 1. Preflight
# --------------------------------------------------------------------------
step "Preflight checks"

for c in node npm docker git gh jq; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "$c $("$c" --version 2>/dev/null | head -n1)"
  elif [ "$c" = "jq" ]; then
    warn "jq not found — version fields will be read via node instead"
  else
    die "Required command not found: $c"
  fi
done

VERSION="$(node -p "require('./package.json').version")"
[ -n "$VERSION" ] || die "Could not read version from package.json"
TAG="v${VERSION}"
MAJOR_MINOR="${VERSION%.*}"

info "Package:      ${NPM_PKG}@${VERSION}"
info "Docker image: ${DOCKER_IMAGE}:${VERSION}"
info "Git tag:      ${TAG}"

# package-lock must agree
LOCK_VERSION="$(node -p "require('./package-lock.json').version" 2>/dev/null || echo '')"
[ "$LOCK_VERSION" = "$VERSION" ] || die "package-lock.json version ($LOCK_VERSION) != package.json ($VERSION). Run: npm version $VERSION --no-git-tag-version"
ok "package-lock.json agrees ($LOCK_VERSION)"

# Working tree should be clean so the tag captures exactly what was tested
if [ -n "$(git status --porcelain)" ]; then
  warn "Working tree is NOT clean:"
  git status --short | sed 's/^/      /'
  confirm "Continue anyway? (the tag will point at the last commit, excluding these changes)" \
    || die "Aborted. Commit or stash your changes first."
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
info "Current branch: ${BRANCH}"

# Refuse to reuse an existing tag
if git rev-parse "$TAG" >/dev/null 2>&1 || git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  die "Tag $TAG already exists locally or on origin. Never reuse a published version — bump to a new patch version."
fi
ok "Tag $TAG is available"

NOTES_FILE="${NOTES_DIR}/RELEASE_NOTES_${TAG}.md"
if [ -f "$NOTES_FILE" ]; then
  ok "Release notes found: $(basename "$NOTES_FILE")"
else
  warn "No release notes file at $(basename "$NOTES_FILE") — the GitHub Release step will need notes typed inline."
fi

confirm "Proceed with release ${TAG}?" || die "Aborted."

# --------------------------------------------------------------------------
# 2. Build, test, audit  (produces dist/ needed by the Docker build)
# --------------------------------------------------------------------------
step "Build, test, and audit"

info "npm ci ..."
npm ci
info "npm run build ..."
npm run build
info "npm test ..."
npm test
info "npm pack audit ..."
node scripts/auditNpmPack.mjs
ok "Build, tests, and tarball audit passed"

# --------------------------------------------------------------------------
# 3. Publish to npm  (interactive: prompts for 2FA OTP if enabled)
# --------------------------------------------------------------------------
step "Publish to npm"

if confirm "Publish ${NPM_PKG}@${VERSION} to npm now?"; then
  if ! npm whoami >/dev/null 2>&1; then
    warn "You are not logged in to npm."
    info "Launching 'npm login' — complete the browser/OTP flow when prompted."
    npm login
  fi
  ok "npm user: $(npm whoami)"
  warn "If 2FA is enabled, npm will prompt for a one-time password (OTP) now."
  # Local publishes cannot generate provenance (that requires CI OIDC); the CI
  # workflow path produces provenance instead.
  npm publish --access public
  ok "Published ${NPM_PKG}@${VERSION} to npm"
else
  warn "Skipped npm publish."
fi

# --------------------------------------------------------------------------
# 4. Wait for npm propagation  (the devcontainer image installs from npm)
# --------------------------------------------------------------------------
step "Verify npm availability"

if confirm "Wait for ${NPM_PKG}@${VERSION} to be visible on the npm registry?"; then
  ATTEMPTS=10
  for i in $(seq 1 "$ATTEMPTS"); do
    PUBLISHED="$(npm view "${NPM_PKG}@${VERSION}" version 2>/dev/null || echo '')"
    if [ "$PUBLISHED" = "$VERSION" ]; then
      ok "Registry reports ${NPM_PKG}@${VERSION}"
      break
    fi
    if [ "$i" -eq "$ATTEMPTS" ]; then
      warn "Not visible after ${ATTEMPTS} attempts — the devcontainer build may fail if you continue."
    else
      info "Attempt ${i}/${ATTEMPTS}: not yet available, retrying in 30s..."
      sleep 30
    fi
  done
else
  warn "Skipped npm propagation check."
fi

# --------------------------------------------------------------------------
# 5. Docker Hub login + build + scan + push
# --------------------------------------------------------------------------
step "Docker images"

if confirm "Build and push Docker images to ${DOCKER_IMAGE}?"; then
  info "Logging in to Docker Hub (docker.io) — enter your username and an access token when prompted."
  docker login docker.io

  HAVE_TRIVY=0
  if command -v trivy >/dev/null 2>&1; then HAVE_TRIVY=1; else
    warn "trivy not installed — skipping the local vulnerability scan (CI still scans before its push)."
  fi

  # ---- Runtime image ----
  info "Building runtime image (${DOCKER_IMAGE}:${VERSION}) ..."
  docker build \
    --build-arg FORMIC_VERSION="${VERSION}" \
    -f Dockerfile \
    -t "${DOCKER_IMAGE}:${VERSION}" \
    -t "${DOCKER_IMAGE}:${MAJOR_MINOR}" \
    -t "${DOCKER_IMAGE}:latest" \
    .

  if [ "$HAVE_TRIVY" -eq 1 ]; then
    info "Scanning runtime image (HIGH,CRITICAL) ..."
    trivy image --severity HIGH,CRITICAL --exit-code 1 "${DOCKER_IMAGE}:${VERSION}" \
      || { confirm "Runtime image has HIGH/CRITICAL findings. Push anyway?" || die "Aborted before pushing runtime image."; }
  fi

  info "Pushing runtime tags ..."
  docker push "${DOCKER_IMAGE}:${VERSION}"
  docker push "${DOCKER_IMAGE}:${MAJOR_MINOR}"
  docker push "${DOCKER_IMAGE}:latest"
  ok "Pushed ${DOCKER_IMAGE}:${VERSION}, :${MAJOR_MINOR}, :latest"

  # ---- Dev-container image (installs @rickywo/formic@VERSION from npm) ----
  info "Building dev-container image (${DOCKER_IMAGE}:${VERSION}-devcontainer) ..."
  docker build \
    --build-arg FORMIC_VERSION="${VERSION}" \
    -f Dockerfile.devcontainer \
    -t "${DOCKER_IMAGE}:${VERSION}-devcontainer" \
    .

  if [ "$HAVE_TRIVY" -eq 1 ]; then
    info "Scanning dev-container image (HIGH,CRITICAL) ..."
    trivy image --severity HIGH,CRITICAL --exit-code 1 "${DOCKER_IMAGE}:${VERSION}-devcontainer" \
      || { confirm "Dev-container image has HIGH/CRITICAL findings. Push anyway?" || die "Aborted before pushing dev-container image."; }
  fi

  info "Pushing dev-container tag ..."
  docker push "${DOCKER_IMAGE}:${VERSION}-devcontainer"
  ok "Pushed ${DOCKER_IMAGE}:${VERSION}-devcontainer"

  warn "First release only: make the Docker Hub repo public at https://hub.docker.com/r/${DOCKER_IMAGE#docker.io/}/settings"
else
  warn "Skipped Docker build/push."
fi

# --------------------------------------------------------------------------
# 6. Git tag + push
# --------------------------------------------------------------------------
step "Git tag"

warn "Pushing ${TAG} triggers the CI release workflow, which will ALSO try to publish."
warn "If you already published above, the CI run's publish steps will fail on 'already exists' (harmless but noisy)."
if confirm "Create and push tag ${TAG} to origin?"; then
  git tag -a "$TAG" -m "Release $TAG"
  git push origin "$TAG"
  ok "Pushed tag ${TAG}"
  TAG_PUSHED=1
else
  warn "Skipped tag creation/push. (A GitHub Release requires the tag to exist on origin.)"
  TAG_PUSHED=0
fi

# --------------------------------------------------------------------------
# 7. GitHub Release page
# --------------------------------------------------------------------------
step "GitHub Release"

if [ "${TAG_PUSHED:-0}" -eq 1 ] && confirm "Create the GitHub Release page for ${TAG}?"; then
  if ! gh auth status >/dev/null 2>&1; then
    info "Launching 'gh auth login' ..."
    gh auth login
  fi
  if [ -f "$NOTES_FILE" ]; then
    gh release create "$TAG" --title "Formic ${TAG}" --notes-file "$NOTES_FILE" --verify-tag
  else
    gh release create "$TAG" --title "Formic ${TAG}" --generate-notes --verify-tag
  fi
  ok "GitHub Release created for ${TAG}"
else
  warn "Skipped GitHub Release."
fi

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
step "Release summary"
ok "Version ${VERSION} release steps complete."
info "Verify:"
info "  npm view ${NPM_PKG}@${VERSION} version"
info "  docker pull ${DOCKER_IMAGE}:${VERSION}"
[ "${TAG_PUSHED:-0}" -eq 1 ] && info "  gh release view ${TAG}"
