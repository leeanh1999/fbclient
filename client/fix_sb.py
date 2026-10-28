"""Make javac --release 8 output loadable by J2ME runtimes/emulators.

javac >= 9 cannot target below Java 8, so:
- string '+' compiles to StringBuilder, which CLDC lacks; rewrite it to
  StringBuffer (same API there);
- class version 52 is rejected by emulators such as KEmulator; set it to
  48 (Java 1.4). Safe because the sources use no Java 5+ bytecode features
  (checked below: no invokedynamic/MethodHandle constant pool entries).
Usage: python fix_sb.py <classes_dir>
"""
import os
import struct
import sys

# Constant pool tag -> fixed payload size (tag 1 = Utf8 is variable).
SIZES = {3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4,
         12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2}


TARGET_MAJOR = 48


def fix(data):
    out = bytearray(data[:10])
    out[4:8] = struct.pack('>HH', 0, TARGET_MAJOR)
    count = struct.unpack('>H', data[8:10])[0]
    pos, i, changed = 10, 1, 0
    while i < count:
        tag = data[pos]
        if tag == 1:
            n = struct.unpack('>H', data[pos + 1:pos + 3])[0]
            s = data[pos + 3:pos + 3 + n]
            t = s.replace(b'java/lang/StringBuilder', b'java/lang/StringBuffer')
            changed += t != s
            out += bytes([1]) + struct.pack('>H', len(t)) + t
            pos += 3 + n
        else:
            if tag >= 15:
                raise ValueError('constant pool tag %d needs class version >= 51' % tag)
            size = SIZES[tag]
            out += data[pos:pos + 1 + size]
            pos += 1 + size
            if tag in (5, 6):  # long/double take two slots
                i += 1
        i += 1
    out += data[pos:]
    return bytes(out), changed


def main(root):
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.endswith('.class'):
                p = os.path.join(dirpath, f)
                with open(p, 'rb') as fh:
                    data, n = fix(fh.read())
                with open(p, 'wb') as fh:
                    fh.write(data)
                print('%s: %d entries rewritten' % (f, n))


if __name__ == '__main__':
    main(sys.argv[1])
