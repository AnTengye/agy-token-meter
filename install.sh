#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGY_TOKEN_METER_REPO:-https://github.com/AnTengye/agy-token-meter.git}"
ARCHIVE_URL="${AGY_TOKEN_METER_ARCHIVE:-https://github.com/AnTengye/agy-token-meter/archive/refs/heads/main.tar.gz}"
TARGET_DIR="${AGY_PLUGIN_DIR:-$HOME/.gemini/config/plugins/token-meter}"
APP_DATA_DIR="${ANTIGRAVITY_APP_DATA_DIR:-$HOME/.gemini/antigravity}"

ACTION="install"
LINK_MODE=0

usage() {
  cat <<'EOF'
Usage: install.sh [install|uninstall|doctor] [--link] [--help]

Commands:
  install     Install or update Token Meter plugin into ~/.gemini/config/plugins/token-meter (default)
  uninstall   Remove the installed plugin directory
  doctor      Verify plugin files, node:sqlite availability, read-only engine, and Sidecar port

Options:
  --link      Symlink local repository directory instead of copying (local repo only)
  -h, --help  Show this help message
EOF
}

for arg in "$@"; do
  case "$arg" in
    install|uninstall|doctor)
      ACTION="$arg"
      ;;
    --link)
      LINK_MODE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '[token-meter][error] Unknown argument: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# All diagnostic logs go to stderr so functions like fetch_source can safely return paths on stdout.
log() {
  printf '[token-meter] %s\n' "$*" >&2
}

warn() {
  printf '[token-meter][warn] %s\n' "$*" >&2
}

die() {
  printf '[token-meter][error] %s\n' "$*" >&2
  exit 1
}

detect_local_source() {
  local src="${BASH_SOURCE[0]:-}"
  if [ -n "$src" ] && [ -f "$src" ]; then
    local dir
    dir="$(cd "$(dirname "$src")" && pwd)"
    if [ -f "$dir/plugin.json" ] && [ -f "$dir/sidecars/meter/main.mjs" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  fi
  if [ -f "$PWD/plugin.json" ] && [ -f "$PWD/sidecars/meter/main.mjs" ]; then
    printf '%s\n' "$PWD"
    return 0
  fi
  return 1
}

TMP_DIR=""
STAGE_DIR=""
DOCTOR_TMP=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR"
  fi
  if [ -n "$DOCTOR_TMP" ] && [ -f "$DOCTOR_TMP" ]; then
    rm -f "$DOCTOR_TMP"
  fi
}
trap cleanup EXIT

fetch_source() {
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-token-meter.XXXXXX")"
  if command -v git >/dev/null 2>&1; then
    log "Cloning $REPO_URL ..."
    if git clone --depth 1 "$REPO_URL" "$TMP_DIR/repo" >/dev/null 2>&1; then
      printf '%s\n' "$TMP_DIR/repo"
      return 0
    fi
    warn "git clone failed, falling back to tarball download ..."
  fi

  command -v curl >/dev/null 2>&1 || die "Neither git clone succeeded nor curl is available."
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack source archive."
  log "Downloading $ARCHIVE_URL ..."
  curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TMP_DIR"
  local extracted
  extracted="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$extracted" ] && [ -f "$extracted/plugin.json" ] || die "Downloaded archive does not contain plugin.json."
  printf '%s\n' "$extracted"
}

find_node_runner() {
  if command -v node >/dev/null 2>&1; then
    if node -e "import('node:sqlite').then(() => process.exit(0)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      printf 'system:%s\n' "$(command -v node)"
      return 0
    fi
  fi

  local agy_helper="/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper"
  if [ -x "$agy_helper" ]; then
    if ELECTRON_RUN_AS_NODE=1 "$agy_helper" -e "import('node:sqlite').then(() => process.exit(0)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      printf 'electron:%s\n' "$agy_helper"
      return 0
    fi
  fi

  return 1
}

run_node_main() {
  local runner="$1"
  shift
  local kind="${runner%%:*}"
  local bin="${runner#*:}"
  if [ "$kind" = "electron" ]; then
    ELECTRON_RUN_AS_NODE=1 "$bin" "$@"
  else
    "$bin" "$@"
  fi
}

move_existing_with_unlock() {
  local target="$1"
  local backup="$2"
  # Remove manifests first so Antigravity stops the running Sidecar and releases directory handles (especially on Windows).
  rm -f "$target/plugin.json" "$target/sidecars/meter/sidecar.json" 2>/dev/null || true

  local attempt=0
  while [ "$attempt" -lt 10 ]; do
    if mv "$target" "$backup" 2>/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  return 1
}

do_install() {
  local src_dir=""
  if src_dir="$(detect_local_source)"; then
    log "Using local source: $src_dir"
  else
    [ "$LINK_MODE" -eq 0 ] || die "--link requires running from a local repository clone."
    src_dir="$(fetch_source)"
  fi

  local plugins_dir
  plugins_dir="$(dirname "$TARGET_DIR")"
  # Keep staging/backup on the same volume but outside plugins/ so Antigravity's watcher never pre-loads a partial directory.
  local stage_root
  stage_root="$(dirname "$plugins_dir")"
  mkdir -p "$plugins_dir" "$stage_root"

  if [ "$LINK_MODE" -eq 1 ]; then
    if [ -L "$TARGET_DIR" ]; then
      rm -f "$TARGET_DIR"
    elif [ -d "$TARGET_DIR" ]; then
      local backup_dir="$stage_root/.token-meter-backup.$$"
      rm -rf "$backup_dir"
      move_existing_with_unlock "$TARGET_DIR" "$backup_dir" || die "Failed to replace existing plugin directory at $TARGET_DIR (directory in use)."
      rm -rf "$backup_dir"
    fi
    ln -s "$src_dir" "$TARGET_DIR"
    log "Linked $TARGET_DIR -> $src_dir"
  else
    STAGE_DIR="$stage_root/.token-meter-stage.$$"
    local backup_dir="$stage_root/.token-meter-backup.$$"
    rm -rf "$STAGE_DIR" "$backup_dir"
    mkdir -p "$STAGE_DIR"

    cp "$src_dir/plugin.json" "$STAGE_DIR/"
    [ -f "$src_dir/README.md" ] && cp "$src_dir/README.md" "$STAGE_DIR/"
    [ -f "$src_dir/LICENSE" ] && cp "$src_dir/LICENSE" "$STAGE_DIR/"
    if [ -f "$src_dir/install.sh" ]; then
      cp "$src_dir/install.sh" "$STAGE_DIR/"
      chmod +x "$STAGE_DIR/install.sh"
    fi
    [ -f "$src_dir/install.ps1" ] && cp "$src_dir/install.ps1" "$STAGE_DIR/"
    [ -f "$src_dir/install.mjs" ] && cp "$src_dir/install.mjs" "$STAGE_DIR/"
    cp -R "$src_dir/assets" "$STAGE_DIR/"
    cp -R "$src_dir/skills" "$STAGE_DIR/"
    cp -R "$src_dir/sidecars" "$STAGE_DIR/"
    find "$STAGE_DIR" -name ".DS_Store" -delete

    if [ -L "$TARGET_DIR" ]; then
      rm -f "$TARGET_DIR"
    elif [ -d "$TARGET_DIR" ]; then
      move_existing_with_unlock "$TARGET_DIR" "$backup_dir" || die "Failed to move existing $TARGET_DIR to backup (directory in use)."
    fi

    if mv "$STAGE_DIR" "$TARGET_DIR"; then
      STAGE_DIR=""
      rm -rf "$backup_dir"
    else
      if [ -d "$backup_dir" ] && [ ! -e "$TARGET_DIR" ]; then
        mv "$backup_dir" "$TARGET_DIR" || true
      fi
      die "Failed to move staged plugin into $TARGET_DIR"
    fi
    log "Installed atomically to $TARGET_DIR"
  fi

  log "Note: ~/.gemini/config/config.json was not modified; Antigravity 2.0 hot-loads plugins automatically."
  do_doctor || true
}

do_uninstall() {
  [ -n "$TARGET_DIR" ] && [ "$TARGET_DIR" != "/" ] || die "Unsafe TARGET_DIR: $TARGET_DIR"
  if [ -L "$TARGET_DIR" ]; then
    rm -f "$TARGET_DIR"
    log "Removed symlink $TARGET_DIR"
  elif [ -d "$TARGET_DIR" ]; then
    local stage_root
    stage_root="$(dirname "$(dirname "$TARGET_DIR")")"
    local backup_dir="$stage_root/.token-meter-uninstall.$$"
    mkdir -p "$stage_root"
    if move_existing_with_unlock "$TARGET_DIR" "$backup_dir"; then
      rm -rf "$backup_dir"
    else
      rm -rf "$TARGET_DIR"
    fi
    log "Removed $TARGET_DIR"
  else
    log "Nothing to remove ($TARGET_DIR does not exist)."
  fi
}

do_doctor() {
  local ok=0
  local required=(
    "plugin.json"
    "assets/logo.svg"
    "skills/token-meter/SKILL.md"
    "sidecars/meter/package.json"
    "sidecars/meter/sidecar.json"
    "sidecars/meter/engine.mjs"
    "sidecars/meter/main.mjs"
    "sidecars/meter/index.html"
    "sidecars/meter/styles.css"
    "sidecars/meter/app.js"
  )

  if [ ! -e "$TARGET_DIR" ]; then
    warn "Plugin is not installed at $TARGET_DIR"
    return 1
  fi

  for rel in "${required[@]}"; do
    if [ ! -f "$TARGET_DIR/$rel" ]; then
      warn "Missing required file: $TARGET_DIR/$rel"
      ok=1
    fi
  done
  [ "$ok" -eq 0 ] && log "Files OK: $TARGET_DIR"

  local runner=""
  if runner="$(find_node_runner)"; then
    local kind="${runner%%:*}"
    local bin="${runner#*:}"
    log "Node SQLite runtime OK ($kind): $bin"
    DOCTOR_TMP="$(mktemp "${TMPDIR:-/tmp}/agy-tm-doctor.XXXXXX")"
    if ANTIGRAVITY_APP_DATA_DIR="$APP_DATA_DIR" run_node_main "$runner" "$TARGET_DIR/sidecars/meter/main.mjs" --overview today >"$DOCTOR_TMP" 2>&1; then
      local summary
      summary="$(tr -d '\n' < "$DOCTOR_TMP" | sed -n 's/.*"totals":[[:space:]]*\({[^}]*}\).*/\1/p')"
      log "Engine read-only test OK: ${summary:-passed}"
    else
      warn "Engine read-only test failed:"
      cat "$DOCTOR_TMP" >&2 || true
      ok=1
    fi
    rm -f "$DOCTOR_TMP"
    DOCTOR_TMP=""
  else
    warn "No Node.js >= 22.5 (with node:sqlite) found in PATH or Antigravity Helper."
    ok=1
  fi

  local sidecar_log="$APP_DATA_DIR/sidecar_data/token-meter/meter/logs/sidecar.log"
  if [ -f "$sidecar_log" ]; then
    local port
    port="$(grep -oE '127\.0\.0\.1:[0-9]+' "$sidecar_log" | tail -n 1 | cut -d: -f2 || true)"
    if [ -n "$port" ] && command -v curl >/dev/null 2>&1; then
      if curl -sf "http://127.0.0.1:$port/" >/dev/null 2>&1; then
        log "Sidecar HTTP server is LIVE on 127.0.0.1:$port"
      else
        warn "Last logged port $port is not responding right now (Antigravity may still be reloading the sidecar)."
      fi
    else
      log "Sidecar log present at $sidecar_log"
    fi
  else
    log "Sidecar log not found yet (Antigravity starts it automatically once enabled)."
  fi

  return "$ok"
}

case "$ACTION" in
  install)
    do_install
    ;;
  uninstall)
    do_uninstall
    ;;
  doctor)
    do_doctor
    ;;
esac
