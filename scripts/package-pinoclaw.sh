#!/usr/bin/env bash
set -euo pipefail

# Build and package PinoClaw for internal NIO distribution.
# No App Store, no Sparkle auto-updates, no notarization required.
#
# Output:
#   dist/PinoClaw.app
#   dist/PinoClaw-<version>.dmg
#
# Signing:
#   - If SIGN_IDENTITY is set, uses that certificate.
#   - Otherwise falls back to ad-hoc signing (ALLOW_ADHOC_SIGNING=1).
#   - Note: ad-hoc-signed apps do NOT persist TCC permissions across restarts.
#     For persistent permissions (Accessibility, Screen Recording, etc.)
#     sign with a real Apple Development certificate.
#
# Build flags:
#   SKIP_TSC=1        skip TypeScript build
#   SKIP_UI_BUILD=1   skip control UI build
#   BUILD_ARCHS=arm64|x86_64|all   (default: current arch)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

APP_PRODUCT="PinoClaw"
BUNDLE_ID="${BUNDLE_ID:-com.nio.pinoclaw.mac}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"

# Build the base OpenClaw app first (disabling Sparkle auto-update feed).
export BUNDLE_ID
export SPARKLE_FEED_URL=""
export SPARKLE_PUBLIC_ED_KEY=""
export BUILD_CONFIG="${BUILD_CONFIG:-release}"
export ALLOW_ADHOC_SIGNING="${ALLOW_ADHOC_SIGNING:-1}"
export SKIP_TEAM_ID_CHECK="${SKIP_TEAM_ID_CHECK:-1}"
export SKIP_NOTARIZE="${SKIP_NOTARIZE:-1}"

echo "🏗  Building $APP_PRODUCT (bundle: $BUNDLE_ID, version: $PKG_VERSION)"
"$ROOT_DIR/scripts/package-mac-app.sh"

SRC_APP="$ROOT_DIR/dist/OpenClaw.app"
DEST_APP="$ROOT_DIR/dist/${APP_PRODUCT}.app"

if [[ ! -d "$SRC_APP" ]]; then
  echo "ERROR: expected app bundle not found at $SRC_APP" >&2
  exit 1
fi

echo "📝 Renaming app bundle to ${APP_PRODUCT}.app"
rm -rf "$DEST_APP"
mv "$SRC_APP" "$DEST_APP"

echo "📝 Updating CFBundleName → $APP_PRODUCT"
/usr/libexec/PlistBuddy -c "Set :CFBundleName ${APP_PRODUCT}" "$DEST_APP/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$DEST_APP/Contents/Info.plist" || true

# Re-sign after plist mutation so the bundle signature stays valid.
echo "🔏 Re-signing $APP_PRODUCT.app after plist update"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$DEST_APP"

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$DEST_APP/Contents/Info.plist" 2>/dev/null || echo "$PKG_VERSION")
DMG="$ROOT_DIR/dist/${APP_PRODUCT}-${VERSION}.dmg"

echo "💿 Creating DMG: $DMG"
DMG_VOLUME_NAME="$APP_PRODUCT" "$ROOT_DIR/scripts/create-dmg.sh" "$DEST_APP" "$DMG"

echo ""
echo "✅ PinoClaw distribution ready:"
echo "   App:  $DEST_APP"
echo "   DMG:  $DMG"
echo ""
echo "📤 To distribute internally, copy $DMG to your internal file server."
echo "   Users: open the DMG, drag PinoClaw.app to Applications."
