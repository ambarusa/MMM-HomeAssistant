#!/bin/bash

set -euo pipefail

# ============================================================================
# MagicMirror Update Script with Logging
# ============================================================================
# Robust update script for MagicMirror and all modules with comprehensive logging
# Suitable for running from Home Assistant, crontab, or manual execution
# ============================================================================

# Configuration
DEFAULT_MM_DIR="${HOME}/MagicMirror"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/update_MM.log"
LOG_COUNT_FILE="${SCRIPT_DIR}/update_MM.count"
MAX_EXECUTIONS_PER_LOG=5
LOCK_FILE="/tmp/magicmirror_update.lock"
PM2_PROCESS_NAME="${PM2_PROCESS_NAME:-mm}"

# Colors for console output (disabled if not a TTY)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# Tracking variables
UPDATES_MADE=0
MODULES_UPDATED=0
MODULES_SKIPPED=0
MODULES_FAILED=0
START_TIME=$(date +%s)

# ============================================================================
# Logging Functions
# ============================================================================

# Handle log rotation after every 5 executions
rotate_logs() {
  local count=0
  if [ -f "$LOG_COUNT_FILE" ]; then
    count=$(cat "$LOG_COUNT_FILE" 2>/dev/null || echo 0)
  fi
  
  count=$((count + 1))
  
  if [ $count -ge $MAX_EXECUTIONS_PER_LOG ]; then
    # Rotate existing logs
    if [ -f "$LOG_FILE" ]; then
      for i in {4..1}; do
        [ -f "${LOG_FILE}.${i}" ] && mv "${LOG_FILE}.${i}" "${LOG_FILE}.$((i+1))"
      done
      mv "$LOG_FILE" "${LOG_FILE}.1"
    fi
    count=0
  fi
  
  echo $count > "$LOG_COUNT_FILE" 2>/dev/null || true
}

# Simplified log with timestamp to file and console
log_msg() {
  local level="$1"
  local msg="$2"
  local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  local formatted="[$timestamp] $msg"
  
  case $level in
    info)   echo -e "${BLUE}${formatted}${NC}" >&2 ;;
    ok)     echo -e "${GREEN}${formatted}${NC}" >&2 ;;
    warn)   echo -e "${YELLOW}${formatted}${NC}" >&2 ;;
    err)    echo -e "${RED}${formatted}${NC}" >&2 ;;
    *)      echo "${formatted}" >&2 ;;
  esac
  
  echo "$formatted" >> "$LOG_FILE" 2>/dev/null || true
}

log_info() { log_msg info "$1"; }
log_success() { log_msg ok "$1"; }
log_warn() { log_msg warn "$1"; }
log_error() { log_msg err "$1"; }

# ============================================================================
# Utility Functions
# ============================================================================

# Check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Check lock file to prevent concurrent runs
check_lock() {
  if [ -f "$LOCK_FILE" ]; then
    local PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if ps -p "$PID" >/dev/null 2>&1; then
      log_error "Another update is already running (PID: $PID)"
      exit 1
    else
      rm -f "$LOCK_FILE"
    fi
  fi
}

# Create lock file
create_lock() {
  echo $$ > "$LOCK_FILE" 2>/dev/null || true
}

# Clean up lock file and temp resources
cleanup() {
  rm -f "$LOCK_FILE"
  log_info "Cleanup complete"
}

# Trap errors and cleanup
trap cleanup EXIT
trap 'log_error "Script interrupted"; exit 130' INT TERM

# ============================================================================
# Validation Functions
# ============================================================================

# Validate required commands
check_requirements() {
  local missing_cmds=()
  
  for cmd in git npm; do
    if ! command_exists "$cmd"; then
      missing_cmds+=("$cmd")
    fi
  done
  
  if [ ${#missing_cmds[@]} -gt 0 ]; then
    log_error "Missing required commands: ${missing_cmds[*]}"
    exit 1
  fi
  
  # Warn if pm2 is not available (non-fatal)
  if ! command_exists pm2; then
    log_warn "pm2 not found - will not auto-restart MagicMirror"
  fi
}

# Validate MagicMirror directory
validate_directories() {
  local mm_dir="${1:-$DEFAULT_MM_DIR}"
  local modules_dir="$mm_dir/modules"
  
  if [ ! -d "$mm_dir" ]; then
    log_error "MagicMirror directory not found: $mm_dir"
    exit 1
  fi
  
  if [ ! -d "$modules_dir" ]; then
    log_error "Modules directory not found: $modules_dir"
    exit 1
  fi
  
  if [ ! -d "$mm_dir/.git" ]; then
    log_error "MagicMirror is not a git repository: $mm_dir"
    exit 1
  fi
  
  echo "$mm_dir"
}

# ============================================================================
# Update Functions
# ============================================================================

# Update MagicMirror base repository
update_base() {
  local mm_dir="$1"
  
  log_info "Updating MagicMirror base directory..."
  
  cd "$mm_dir" || exit 1
  
  # Reset to avoid conflicts
  if ! git reset --hard HEAD >/dev/null 2>&1; then
    log_warn "Failed to reset git state, attempting to continue"
  fi
  
  # Pull latest changes
  local git_output
  git_output=$(git pull 2>&1) || {
    log_error "Failed to pull updates from git"
    return 1
  }
  
  # Check if updates were made
  if echo "$git_output" | grep -q "Already up to date"; then
    log_info "Base directory is already up to date"
    return 0
  fi
  
  log_info "New changes found for base directory"
  
  # Run npm install for base
  if npm run install-mm 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
    log_success "Successfully installed base dependencies"
    UPDATES_MADE=1
    return 0
  else
    log_error "Failed to run npm install-mm"
    return 1
  fi
}

# Update a single module
update_module() {
  local module_path="$1"
  local module_name
  module_name=$(basename "$module_path")
  
  # Skip non-git modules
  if [ ! -d "$module_path/.git" ]; then
    log_warn "Skipping $module_name (not a git repository)"
    ((MODULES_SKIPPED++))
    return 0
  fi
  
  log_info "Updating $module_name..."
  
  cd "$module_path" || return 1
  
  # Reset to clean state
  if ! git reset --hard HEAD >/dev/null 2>&1; then
    log_warn "$module_name: Failed to reset git state"
  fi
  
  # Pull latest changes
  local git_output
  if ! git_output=$(git pull 2>&1); then
    log_error "Failed to pull $module_name"
    ((MODULES_FAILED++))
    return 1
  fi
  
  # Check if updates were made
  if echo "$git_output" | grep -q "Already up to date"; then
    log_info "$module_name is already up to date"
    ((MODULES_SKIPPED++))
    return 0
  fi
  
  log_info "New changes found for $module_name"
  
  # Install dependencies if package.json exists
  if [ -f "package.json" ]; then
    if npm install 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
      log_success "Successfully updated $module_name"
      ((MODULES_UPDATED++))
      UPDATES_MADE=1
      return 0
    else
      log_error "Failed to install dependencies for $module_name"
      ((MODULES_FAILED++))
      return 1
    fi
  else
    log_success "Updated $module_name (no npm dependencies)"
    ((MODULES_UPDATED++))
    UPDATES_MADE=1
    return 0
  fi
}

# Update all modules
update_modules() {
  local modules_dir="$1"
  local module_count=0
  
  log_info "Finding modules in $modules_dir..."
  
  # Find all MMM-* directories
  while IFS= read -r -d '' module; do
    ((module_count++))
    update_module "$module" || true
  done < <(find "$modules_dir" -maxdepth 1 -type d -name "MMM-*" -print0)
  
  log_info "Module update complete ($module_count modules found)"
}

# Restart MagicMirror via PM2
restart_magicmirror() {
  if ! command_exists pm2; then
    log_warn "pm2 not available - skipping auto-restart"
    log_info "Please manually restart MagicMirror: pm2 restart $PM2_PROCESS_NAME"
    return 0
  fi
  
  log_info "Restarting MagicMirror process: $PM2_PROCESS_NAME..."
  
  if pm2 restart "$PM2_PROCESS_NAME" >/dev/null 2>&1; then
    log_success "MagicMirror restarted successfully"
    return 0
  else
    log_error "Failed to restart MagicMirror"
    return 1
  fi
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
  rotate_logs
  
  log_info "=========================================="
  log_info "MagicMirror Update Script"
  log_info "=========================================="
  log_info "Log file: $LOG_FILE"
  
  # Check prerequisites
  check_lock
  create_lock
  check_requirements
  
  # Get and validate MagicMirror directory
  local magicmirror_dir
  magicmirror_dir=$(validate_directories "${1:-$DEFAULT_MM_DIR}")
  
  log_info "MagicMirror directory: $magicmirror_dir"
  
  # Perform updates
  update_base "$magicmirror_dir" || log_warn "Base update had issues"
  update_modules "$magicmirror_dir/modules"
  
  # Restart if updates were made
  if [ $UPDATES_MADE -eq 1 ]; then
    log_info "Updates detected - restarting MagicMirror"
    restart_magicmirror || log_warn "Restart may have failed"
  else
    log_info "No updates detected - skipping restart"
  fi
  
  # Summary
  local end_time=$(date +%s)
  local duration=$((end_time - START_TIME))
  
  log_info "=========================================="
  log_success "Update process complete!"
  log_info "Duration: ${duration}s"
  log_info "Modules updated: $MODULES_UPDATED"
  log_info "Modules skipped: $MODULES_SKIPPED"
  log_info "Modules failed: $MODULES_FAILED"
  log_info "=========================================="
}

# Run main function
main "$@"
exit 0

