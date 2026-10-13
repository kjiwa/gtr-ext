# shellcheck shell=sh
# Sourced by gh-cut from the repository root.

# shellcheck disable=SC2034 # read by gh-cut
RELEASE_BY_WORKFLOW=1

release_version() {
  _release_version_manifest=$(node -p "require('./static/manifest.json').version")
  _release_version_package=$(node -p "require('./package.json').version")
  if [ "$_release_version_manifest" != "$_release_version_package" ]; then
    echo "static/manifest.json ($_release_version_manifest) and package.json ($_release_version_package) disagree" >&2
    return 1
  fi
  echo "$_release_version_manifest"
}

release_bump() {
  _release_bump_version="$1"
  npm version "$_release_bump_version" --no-git-tag-version
  sed 's/^  "version": ".*",$/  "version": "'"$_release_bump_version"'",/' static/manifest.json >static/manifest.json.new
  mv static/manifest.json.new static/manifest.json
  release_version >/dev/null
}

release_checks() {
  npm run lint
  npm run typecheck
  npm test
  npm run pkg
  npm run lint:ext
}
