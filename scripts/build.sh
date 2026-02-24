#!/bin/bash
# Build script for AIAssistant
# Produces ./aiassistant executable (Node.js bundle + launcher)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

echo "🔨 Building AIAssistant..."

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Compile TypeScript
echo "  Compiling TypeScript..."
cd "$PROJECT_DIR"
npx tsc

# Bundle with esbuild
echo "  Bundling with esbuild..."
npx esbuild dist/index.js \
  --bundle \
  --platform=node \
  --target=node18 \
  --outfile="$BUILD_DIR/cli.js" \
  --external:better-sqlite3 \
  --external:blessed \
  --external:telegraf \
  --external:inquirer

npx esbuild dist/daemon/start.js \
  --bundle \
  --platform=node \
  --target=node18 \
  --outfile="$BUILD_DIR/daemon-start.js" \
  --external:better-sqlite3 \
  --external:blessed \
  --external:telegraf \
  --external:inquirer

# Copy native dependencies
echo "  Copying dependencies..."
cp -r "$PROJECT_DIR/node_modules" "$BUILD_DIR/node_modules" 2>/dev/null || true

# Copy plugins
echo "  Copying plugins..."
cp -r "$PROJECT_DIR/plugins" "$BUILD_DIR/plugins"

# Create launcher script
cat > "$BUILD_DIR/aiassistant" << 'LAUNCHER'
#!/bin/bash
# AIAssistant launcher
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/cli.js" "$@"
LAUNCHER
chmod +x "$BUILD_DIR/aiassistant"

echo ""
echo "✅ Build complete!"
echo "   Artifact: $BUILD_DIR/aiassistant"
echo ""
echo "   Usage:"
echo "     $BUILD_DIR/aiassistant setup     # First-time setup"
echo "     $BUILD_DIR/aiassistant start     # Start daemon"
echo "     $BUILD_DIR/aiassistant tui       # Attach TUI"
echo "     $BUILD_DIR/aiassistant --help    # Show all commands"
