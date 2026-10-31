#!/usr/bin/env python3
"""Pull a Docker/OCI image from a registry without Docker and unpack it as a rootfs.

Used on the Android phone (no Docker): the arm64 image that CI publishes
becomes a chroot. Standard library only (Termux: pkg install python). Run as
root so file owners are kept.

  pull-image.py ghcr.io/leeanh1999/fbclient:latest /data/local/fbclient/rootfs.new [--skip-digest sha256:...]

Writes <dest>/.fbc-env (the image's ENV as shell exports) and <dest>/.fbc-image
(reference + digest). Exit code 3: the image digest equals --skip-digest
(nothing downloaded).
"""
import hashlib
import json
import os
import shutil
import sys
import tarfile
import urllib.parse
import urllib.request

ARCH = 'arm64'
ACCEPT = ', '.join([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
])


class NoAuthOnRedirect(urllib.request.HTTPRedirectHandler):
    """Blobs redirect to signed storage URLs, which reject the registry token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlparse(newurl).netloc != urllib.parse.urlparse(req.full_url).netloc:
            new.remove_header('Authorization')
        return new


opener = urllib.request.build_opener(NoAuthOnRedirect)


def parse_ref(ref):
    host, _, rest = ref.partition('/')
    name, _, tag = rest.partition(':')
    return host, name, tag or 'latest'


def token(host, name):
    # Anonymous pull token (public package).
    url = 'https://%s/token?scope=repository:%s:pull' % (host, name)
    with opener.open(url, timeout=30) as r:
        return json.load(r)['token']


def get(host, name, path, tok, accept=None):
    req = urllib.request.Request('https://%s/v2/%s/%s' % (host, name, path))
    req.add_header('Authorization', 'Bearer ' + tok)
    if accept:
        req.add_header('Accept', accept)
    return opener.open(req, timeout=60)


def manifest(host, name, ref, tok):
    with get(host, name, 'manifests/' + ref, tok, ACCEPT) as r:
        digest = r.headers.get('Docker-Content-Digest', '')
        return json.load(r), digest


class HashReader:
    """Reads a stream while hashing it, to check the layer digest."""

    def __init__(self, f):
        self.f = f
        self.h = hashlib.sha256()
        self.n = 0

    def read(self, size=-1):
        b = self.f.read(size)
        self.h.update(b)
        self.n += len(b)
        return b


def remove(path):
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)


def inside(dest, path):
    full = os.path.normpath(os.path.join(dest, path))
    if not (full == dest or full.startswith(dest + os.sep)):
        raise SystemExit('unsafe path in layer: ' + path)
    return full


def apply_layer(fileobj, dest):
    extra = {'filter': 'fully_trusted'} if hasattr(tarfile, 'fully_trusted_filter') else {}
    with tarfile.open(fileobj=fileobj, mode='r|*') as tf:
        for m in tf:
            name = m.name
            while name.startswith('./'):
                name = name[2:]
            name = name.lstrip('/')
            if not name:
                continue
            d, base = os.path.split(name)
            # Whiteouts: a file deleted, or a directory replaced, by this layer.
            if base == '.wh..wh..opq':
                target = inside(dest, d)
                if os.path.isdir(target) and not os.path.islink(target):
                    for e in os.listdir(target):
                        remove(os.path.join(target, e))
                continue
            if base.startswith('.wh.'):
                remove(inside(dest, os.path.join(d, base[4:])))
                continue
            target = inside(dest, name)
            if os.path.lexists(target) and not (m.isdir() and os.path.isdir(target) and not os.path.islink(target)):
                remove(target)
            m.name = name
            tf.extract(m, dest, numeric_owner=True, **extra)


def main():
    args = sys.argv[1:]
    skip = None
    if '--skip-digest' in args:
        i = args.index('--skip-digest')
        skip = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        raise SystemExit(__doc__)
    ref, dest = args
    dest = os.path.abspath(dest)
    host, name, tag = parse_ref(ref)
    tok = token(host, name)

    man, digest = manifest(host, name, tag, tok)
    if 'manifests' in man:  # multi-platform index: take linux/arm64
        picks = [m for m in man['manifests']
                 if m.get('platform', {}).get('architecture') == ARCH
                 and m.get('platform', {}).get('os') == 'linux']
        if not picks:
            raise SystemExit('no linux/%s image in %s' % (ARCH, ref))
        digest = picks[0]['digest']
        man, _ = manifest(host, name, digest, tok)
    print('image %s %s' % (ref, digest), flush=True)
    if skip and skip == digest:
        print('unchanged', flush=True)
        sys.exit(3)

    with get(host, name, 'blobs/' + man['config']['digest'], tok) as r:
        config = json.load(r).get('config', {})

    if os.path.lexists(dest):
        raise SystemExit('destination exists: ' + dest)
    os.makedirs(dest)
    layers = man['layers']
    total = sum(l.get('size', 0) for l in layers)
    done = 0
    for i, l in enumerate(layers, 1):
        mt = l.get('mediaType', '')
        if 'zstd' in mt:
            raise SystemExit('zstd layers are not supported: ' + mt)
        print('layer %d/%d %.1f MB (%.0f%% of %.0f MB)' % (
            i, len(layers), l['size'] / 1e6, 100.0 * done / max(total, 1), total / 1e6), flush=True)
        with get(host, name, 'blobs/' + l['digest'], tok) as r:
            hr = HashReader(r)
            apply_layer(hr, dest)
            while hr.read(1 << 20):  # rest of the stream (tar padding)
                pass
        if 'sha256:' + hr.h.hexdigest() != l['digest']:
            raise SystemExit('digest mismatch in layer %d' % i)
        done += l['size']

    env = config.get('Env') or []
    with open(os.path.join(dest, '.fbc-env'), 'w') as f:
        for e in env:
            k, _, v = e.partition('=')
            f.write("export %s='%s'\n" % (k, v.replace("'", "'\\''")))
        f.write("export FBC_WORKDIR='%s'\n" % (config.get('WorkingDir') or '/'))
    with open(os.path.join(dest, '.fbc-image'), 'w') as f:
        f.write('%s %s\n' % (ref, digest))
    print('done %s' % digest, flush=True)


if __name__ == '__main__':
    main()
