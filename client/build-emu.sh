#!/bin/sh
# Offline build for emulators: JDK only, compiled against local API stubs.
# Output is class version 48 (patched by fix_sb.py) without CLDC preverification, so it runs on
# J2ME Loader / KEmulator / FreeJ2ME / MicroEmulator, not on real phones
# (use build.sh for those).
#
# Usage: sh build-emu.sh [dev|prod]
#   dev  (default) server = http://127.0.0.1:8080
#   prod           server = SERVER_URL from env or prod.conf
set -e
cd "$(dirname "$0")"

PROFILE=${1:-dev}
case "$PROFILE" in
    dev) SERVER_URL=${SERVER_URL:-http://127.0.0.1:8080} ;;
    prod)
        if [ -z "$SERVER_URL" ]; then
            SERVER_URL=$(sed -n 's/^SERVER_URL=//p' prod.conf | tr -d '\r ')
        fi
        if [ -z "$SERVER_URL" ]; then
            echo "prod build: set SERVER_URL in prod.conf or env" >&2
            exit 1
        fi
        ;;
    *) echo "usage: $0 [dev|prod]" >&2; exit 1 ;;
esac
OUT=${OUT:-dist}   # override if the jar is locked by a running emulator
rm -rf build-emu
mkdir -p build-emu/stubs build-emu/classes "$OUT"

javac --release 8 -nowarn -d build-emu/stubs $(find stubs -name '*.java')
javac --release 8 -nowarn -encoding UTF-8 -Xlint:-options -cp build-emu/stubs \
    -d build-emu/classes $(find src -name '*.java')
python fix_sb.py build-emu/classes

cat > build-emu/MANIFEST.MF <<EOF
Manifest-Version: 1.0
MIDlet-Name: FbClient
MIDlet-Vendor: fbclient
MIDlet-Version: 1.0.0
MIDlet-1: Facebook, /icon.png, fbc.FbMidlet
MIDlet-Icon: /icon.png
MicroEdition-Profile: MIDP-2.0
MicroEdition-Configuration: CLDC-1.1
FbClient-Server: $SERVER_URL
Nokia-MIDlet-On-Screen-Keypad: no
EOF
jar cfm build-emu/FbClient.jar build-emu/MANIFEST.MF -C build-emu/classes . -C res .

# Copy last so a jar locked by a running emulator fails with a clear message.
if ! cp build-emu/FbClient.jar "$OUT/FbClient.jar" 2>/dev/null; then
    echo "Cannot write $OUT/FbClient.jar (open in an emulator?). Close it or run: OUT=dist-new sh $0" >&2
    exit 1
fi
SIZE=$(wc -c < "$OUT/FbClient.jar" | tr -d ' ')
cat > "$OUT/FbClient.jad" <<EOF
MIDlet-Name: FbClient
MIDlet-Vendor: fbclient
MIDlet-Version: 1.0.0
MIDlet-1: Facebook, /icon.png, fbc.FbMidlet
MIDlet-Icon: /icon.png
MIDlet-Jar-URL: FbClient.jar
MIDlet-Jar-Size: $SIZE
MicroEdition-Profile: MIDP-2.0
MicroEdition-Configuration: CLDC-1.1
FbClient-Server: $SERVER_URL
Nokia-MIDlet-On-Screen-Keypad: no
EOF
echo "Built $OUT/FbClient.jar ($SIZE bytes, $PROFILE, server $SERVER_URL)"
