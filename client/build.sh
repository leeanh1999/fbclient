#!/usr/bin/env bash
# Builds build/FbClient.jar + build/FbClient.jad for real phones: class
# version 45 with CLDC StackMap (preverified). Needs JDK 11+ and Maven (only
# to download the tools). Works on Linux and Git Bash. Used by CI.
#
#   ./build.sh [dev|prod]     dev (default): server http://127.0.0.1:8080
#                             prod: SERVER_URL from env or prod.conf
#   VERSION=1.2.3 ./build.sh  MIDlet-Version (numbers only)
#
# For emulators without Maven/network, build-emu.sh needs only a JDK.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${1:-dev}"
case "$PROFILE" in
  dev) SERVER_URL="${SERVER_URL:-http://127.0.0.1:8080}" ;;
  prod)
    if [ -z "${SERVER_URL:-}" ]; then
      SERVER_URL=$(sed -n 's/^SERVER_URL=//p' prod.conf | tr -d '\r ')
    fi
    [ -n "$SERVER_URL" ] || { echo "prod build: set SERVER_URL in prod.conf or env" >&2; exit 1; }
    ;;
  *) echo "usage: $0 [dev|prod]" >&2; exit 1 ;;
esac

VERSION="${VERSION:-1.0.0}"
OUT=build
LIB=$OUT/lib
SEP=":"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";" ;; esac

rm -rf "$OUT/classes" "$OUT"/*.jar "$OUT"/*.jad
mkdir -p "$OUT/classes"

# 1. Tools: ECJ compiler, ProGuard, phone APIs.
if [ ! -f "$LIB/ecj-3.26.0.jar" ]; then
  mvn -q -f tools/pom.xml dependency:copy-dependencies -DoutputDirectory="../$LIB"
fi
API="$LIB/cldcapi11-2.0.4.jar${SEP}$LIB/midpapi20-2.0.4.jar${SEP}$LIB/microemu-jsr-135-2.0.4.jar"

# 2. Compile to 1.1 bytecode (CLDC rejects newer class files).
java -jar "$LIB/ecj-3.26.0.jar" -source 1.3 -target 1.1 -encoding UTF-8 -nowarn \
  -bootclasspath "$API" -d "$OUT/classes" src

# 3. Manifest and package (not yet preverified).
cat > "$OUT/MANIFEST.MF" <<EOF
Manifest-Version: 1.0
MIDlet-Name: FbClient
MIDlet-Vendor: fbclient
MIDlet-Version: $VERSION
MIDlet-1: FbClient, /icon.png, fbc.FbMidlet
MIDlet-Icon: /icon.png
MicroEdition-Configuration: CLDC-1.1
MicroEdition-Profile: MIDP-2.0
FbClient-Server: $SERVER_URL
Nokia-MIDlet-Category: Application
Nokia-MIDlet-On-Screen-Keypad: no
EOF
jar cfm "$OUT/raw.jar" "$OUT/MANIFEST.MF" -C "$OUT/classes" . -C res .

# 4. ProGuard: preverify (-microedition adds CLDC StackMap), drop unused code.
java -cp "$LIB/*" proguard.ProGuard \
  -injars "$OUT/raw.jar" \
  -outjars "$OUT/FbClient.jar" \
  -libraryjars "$API" \
  -microedition \
  -dontoptimize \
  -dontobfuscate \
  -dontnote \
  -keep 'public class * extends javax.microedition.midlet.MIDlet'
rm -f "$OUT/raw.jar"

# 5. JAD: Nokia phones read the jar size from here.
SIZE=$(wc -c < "$OUT/FbClient.jar" | tr -d ' ')
{
  grep -v '^Manifest-Version' "$OUT/MANIFEST.MF"
  echo "MIDlet-Jar-URL: FbClient.jar"
  echo "MIDlet-Jar-Size: $SIZE"
} > "$OUT/FbClient.jad"

echo "Built $OUT/FbClient.jar ($SIZE bytes, $PROFILE, server $SERVER_URL), $OUT/FbClient.jad"
