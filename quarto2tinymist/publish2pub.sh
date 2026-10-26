#!/bin/zsh
# Release by pushing a tag: .github/workflows/publish-qmd2typ-pro.yml then builds the
# .vsix, creates the GitHub release and publishes to Open VSX via trusted publishing
# (no OVSX_PAT needed). The run waits for approval in the "publish" environment.
set -e

CURRENT_VERSION=$(node -p "require('./package.json').version")
TAG="qmd2typ-pro-v$CURRENT_VERSION"
echo "Releasing version: $CURRENT_VERSION (tag $TAG)"

# 1. The tag must point at committed, pushed code.
if [[ -n "$(git status --porcelain -- .)" ]]; then
    echo " -> Error: uncommitted changes in $(basename "$PWD"). Commit them first."
    exit 1
fi
git fetch -q origin
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ]]; then
    echo " -> Error: HEAD is not in sync with $(git rev-parse --abbrev-ref @{u}). Push (or pull) first."
    exit 1
fi

# 2. Each version is released once; bump package.json for a new release.
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    echo " -> Error: $TAG already exists on GitHub. Bump the version in package.json first."
    exit 1
fi

# 3. Tag and push; this starts the publish workflow.
git tag "$TAG"
git push origin "$TAG"

echo "Pushed $TAG. Approve the run in GitHub Actions:"
echo "  https://github.com/longhaiSK/vs-code-extensions/actions/workflows/publish-qmd2typ-pro.yml"
