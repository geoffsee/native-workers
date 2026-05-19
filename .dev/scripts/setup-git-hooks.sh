#!/usr/bin/env bash
# Install pre-commit and pre-push hooks for workers-native.
# Run from anywhere inside the package:
#   bash .dev/scripts/setup-git-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PKG_ROOT}"

HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "${HOOKS_DIR}"

PRE_COMMIT="${HOOKS_DIR}/pre-commit"
PRE_PUSH="${HOOKS_DIR}/pre-push"

cat > "${PRE_COMMIT}" <<'HOOK'
#!/usr/bin/env bash
# Pre-commit hook: typecheck + test for workers-native.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "[pre-commit] typecheck"
bun run typecheck

echo "[pre-commit] test"
bun run test
HOOK

cat > "${PRE_PUSH}" <<'HOOK'
#!/usr/bin/env bash
# Pre-push hook: typecheck + test for workers-native.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "[pre-push] typecheck"
bun run typecheck

echo "[pre-push] test"
bun run test
HOOK

chmod +x "${PRE_COMMIT}" "${PRE_PUSH}"

echo "Installed hooks:"
echo "  ${PRE_COMMIT}"
echo "  ${PRE_PUSH}"
