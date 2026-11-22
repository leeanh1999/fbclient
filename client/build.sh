#!/usr/bin/env bash
# Builds build/FbClient.jar + build/FbClient.jad for real phones: class
# version 45 with CLDC StackMap (preverified). Needs JDK 11+ and Maven (only
# to download the tools). Works on Linux and Git Bash. Used by CI.
#
#   ./build.sh
#   VERSION=1.2.3 ./build.sh  MIDlet-Version (numbers only)
#
# The jar carries no server address: the app asks for it on its first start
# (Settings changes it later).
#
# For emulators without Maven/network, build-emu.sh needs only a JDK.
set -euo pipefail
cd "$(dirname "$0")"

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
# Vendor API (Nokia) as stubs: compiled against, never packed.
rm -rf "$OUT/vendor"
mkdir -p "$OUT/vendor"
java -jar "$LIB/ecj-3.26.0.jar" -source 1.3 -target 1.1 -nowarn -bootclasspath "$API" -d "$OUT/vendor" stubs/com
API="$API${SEP}$OUT/vendor"

# 2. Compile to 1.1 bytecode (CLDC rejects newer class files).
java -jar "$LIB/ecj-3.26.0.jar" -source 1.3 -target 1.1 -encoding UTF-8 -nowarn \
  -bootclasspath "$API" -d "$OUT/classes" src

# 3. Manifest; packaged per jar below (not yet preverified).
cat > "$OUT/MANIFEST.MF" <<EOF
Manifest-Version: 1.0
MIDlet-Name: FbClient
MIDlet-Vendor: fbclient
MIDlet-Version: $VERSION
MIDlet-1: Facebook, /icon.png, fbc.FbMidlet
MIDlet-Icon: /icon.png
MicroEdition-Configuration: CLDC-1.1
MicroEdition-Profile: MIDP-2.0
Nokia-MIDlet-Category: Application
Nokia-MIDlet-On-Screen-Keypad: no
EOF
# Two jars, the same app: FbClient.jar for Nokia and the rest (with the Nokia
# backlight helper) and FbClient-bb.jar for BlackBerry, which refuses to
# install a jar that mentions a Nokia class (and to start one that uses its
# own signed APIs, so it has no maker helper at all). Lights loads the
# helper by name.
package() { # <jar name> <class left out, or "none">
  local name=$1 drop=$2
  rm -rf "$OUT/pkg" && cp -r "$OUT/classes" "$OUT/pkg"
  rm -f "$OUT/pkg/fbc/$drop.class"
  jar cfm "$OUT/raw.jar" "$OUT/MANIFEST.MF" -C "$OUT/pkg" . -C res .

  # 4. ProGuard: preverify (-microedition adds CLDC StackMap), drop unused
  # code (but not the helper, only loaded by name).
  java -cp "$LIB/*" proguard.ProGuard \
    -injars "$OUT/raw.jar" \
    -outjars "$OUT/$name.jar" \
    -libraryjars "$API" \
    -microedition \
    -dontoptimize \
    -dontobfuscate \
    -dontnote \
    -keep 'public class * extends javax.microedition.midlet.MIDlet' \
    -keep 'public class fbc.NokiaLights { *; }'
  rm -rf "$OUT/raw.jar" "$OUT/pkg"

  # 5. JAD: Nokia phones read the jar size from here.
  local size
  size=$(wc -c < "$OUT/$name.jar" | tr -d ' ')
  {
    grep -v '^Manifest-Version' "$OUT/MANIFEST.MF"
    echo "MIDlet-Jar-URL: $name.jar"
    echo "MIDlet-Jar-Size: $size"
  } > "$OUT/$name.jad"
  echo "Built $OUT/$name.jar ($size bytes), $OUT/$name.jad"
}
package FbClient none
package FbClient-bb NokiaLights
