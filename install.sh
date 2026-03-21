#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="codex-feishu-bridge.service"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${CONFIG_HOME}/codex-feishu-bridge"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/systemd/${UNIT_NAME}.in"
UNIT_PATH="${SYSTEMD_DIR}/${UNIT_NAME}"
ENV_TEMPLATE="${ROOT_DIR}/deploy/config/bridge.env.example"
JSON_TEMPLATE="${ROOT_DIR}/deploy/config/config.json"
ENV_PATH="${CONFIG_DIR}/bridge.env"
JSON_PATH="${CONFIG_DIR}/config.json"
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"

echo "This will clean, install packages, build, install the package globally, install/update the user service, kill old bridge processes, and restart the service."
echo "repo: ${ROOT_DIR}"
echo "unit: ${UNIT_PATH}"
echo "config: ${ENV_PATH}"
echo "config: ${JSON_PATH}"
echo "note: config.json is the primary bridge config; bridge.env is only for secrets and process env."
if [[ -f "${JSON_PATH}" ]]; then
  echo "note: existing config.json will be preserved; checked-in defaults like backendMode/app-server are only applied on first install."
fi
read -r -p "Continue? [y/N] " CONFIRM
if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
  echo "aborted"
  exit 1
fi

cd "${ROOT_DIR}"

rm -rf dist
npm install
npm run build
PACK_FILE="$(npm pack --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['filename'])")"
GLOBAL_PREFIX="$(npm prefix -g)"
GLOBAL_ROOT="$(npm root -g)"
GLOBAL_PKG_DIR="${GLOBAL_ROOT}/codex-feishu-bridge"
GLOBAL_BIN_DIR="${GLOBAL_PREFIX}/bin"

mkdir -p "${GLOBAL_ROOT}" "${GLOBAL_BIN_DIR}"
rm -rf "${GLOBAL_PKG_DIR}"
mkdir -p "${GLOBAL_PKG_DIR}"
tar -xzf "./${PACK_FILE}" -C "${GLOBAL_PKG_DIR}" --strip-components=1
cp -a node_modules "${GLOBAL_PKG_DIR}/"
ln -sf "${GLOBAL_PKG_DIR}/bin/codex-feishu-bridge.js" "${GLOBAL_BIN_DIR}/codex-feishu-bridge"
chmod +x "${GLOBAL_PKG_DIR}/bin/codex-feishu-bridge.js" "${GLOBAL_BIN_DIR}/codex-feishu-bridge"
rm -f "${PACK_FILE}"

BIN_PATH="$(command -v codex-feishu-bridge || true)"
if [[ -z "${BIN_PATH}" ]]; then
  echo "codex-feishu-bridge not found on PATH after npm install -g ." >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}" "${SYSTEMD_DIR}"

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  python3 - "${ENV_PATH}" "${USER_HOME}" "${ROOT_DIR}" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
user_home = sys.argv[2]
text = env_path.read_text()
text = text.replace("$HOME", user_home)
env_path.write_text(text)
PY
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  cp "${JSON_TEMPLATE}" "${JSON_PATH}"
  python3 - "${JSON_PATH}" "${USER_HOME}" "${ROOT_DIR}" <<'PY'
from pathlib import Path
import json
import sys

json_path = Path(sys.argv[1])
user_home = sys.argv[2]
root_dir = sys.argv[3]
data = json.loads(json_path.read_text())

def replace_home(value):
    if isinstance(value, str):
        return value.replace("$HOME", user_home)
    if isinstance(value, list):
        return [replace_home(item) for item in value]
    if isinstance(value, dict):
        return {key: replace_home(item) for key, item in value.items()}
    return value

data = replace_home(data)
project = data.setdefault("project", {})
allowed_roots = project.setdefault("allowedRoots", [user_home])
if root_dir not in allowed_roots:
    allowed_roots.append(root_dir)
project["defaultPath"] = root_dir
json_path.write_text(json.dumps(data, indent=2) + "\n")
PY
fi

sed \
  -e "s|@BIN_PATH@|${BIN_PATH}|g" \
  -e "s|@HOME@|${USER_HOME}|g" \
  -e "s|@PATH@|${PATH_VALUE}|g" \
  "${UNIT_TEMPLATE}" > "${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}" >/dev/null

systemctl --user stop "${UNIT_NAME}" || true
for _ in $(seq 1 50); do
  if ! systemctl --user is-active --quiet "${UNIT_NAME}"; then
    break
  fi
  sleep 0.2
done
systemctl --user kill --signal=SIGKILL "${UNIT_NAME}" || true
systemctl --user daemon-reload
systemctl --user reset-failed "${UNIT_NAME}" || true
systemctl --user start "${UNIT_NAME}"

echo "verifying service..."
systemctl --user is-active "${UNIT_NAME}" >/dev/null
systemctl --user show "${UNIT_NAME}" -p MainPID -p ExecMainPID -p ActiveEnterTimestamp -p SubState
if [[ -f "${JSON_PATH}" ]]; then
  python3 - "${JSON_PATH}" <<'PY'
from pathlib import Path
import json
import sys

json_path = Path(sys.argv[1])
data = json.loads(json_path.read_text())
codex = data.get("codex", {}) if isinstance(data, dict) else {}
backend = codex.get("backendMode", "(missing)")
sandbox = codex.get("sandboxMode", "(missing)")
approval_timeout = codex.get("approvalTimeoutMs", "(missing)")
print(f"config backendMode={backend}")
print(f"config sandboxMode={sandbox}")
print(f"config approvalTimeoutMs={approval_timeout}")
PY
fi
