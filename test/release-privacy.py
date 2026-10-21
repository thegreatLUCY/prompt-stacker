"""Audit package inputs and unpublished Git blobs without printing matched secrets.
Run from the repository root: python3 test/release-privacy.py [package.zip]
Findings are review signals, not a guarantee that all private content is detected.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import zipfile

SHIPPING = 'manifest.json content.js panel.css images-tab.js busy-lock.js zip-lib.js grabber.js library.js thread.js icon16.png icon48.png icon128.png'.split()
PATTERNS = {
    'machine_path': re.compile(rb'/(?:Users|home)/[^/\s"\x27]+'),
    'private_chat_link': re.compile(rb'https://chatgpt\.com/c/[0-9a-f-]{20,}'),
    'jwt': re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),
    'secret_key': re.compile(rb'(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)'),
    'signed_image_url': re.compile(rb'(?:sig|signature|X-Amz-Signature)=[a-zA-Z0-9%/+]{24,}'),
}

def git(*args):
    return subprocess.check_output(['git', *args])

def inspect(data, label):
    findings = [{'file': label, 'kind': kind} for kind, pattern in PATTERNS.items() if pattern.search(data)]
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        pos = 8
        while pos + 12 <= len(data):
            size = struct.unpack('>I', data[pos:pos+4])[0]
            kind = data[pos+4:pos+8]
            if kind in (b'tEXt', b'zTXt', b'iTXt', b'eXIf'):
                findings.append({'file': label, 'kind': 'image_metadata_requires_review'})
            pos += size + 12
    if data.startswith(b'PK\x03\x04'):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for name in archive.namelist():
                    if archive.getinfo(name).file_size <= 10 * 1024 * 1024:
                        findings.extend(inspect(archive.read(name), label + ':' + name))
                    else:
                        findings.append({'file': label + ':' + name, 'kind': 'large_archive_entry_requires_review'})
        except zipfile.BadZipFile:
            findings.append({'file': label, 'kind': 'invalid_archive'})
    return findings

inputs = []
for name in SHIPPING:
    data = Path(name).read_bytes()
    inputs.append({'file': name, 'sha256': hashlib.sha256(data).hexdigest(), 'findings': inspect(data, name)})
commits = git('rev-list', 'origin/main..HEAD').decode().splitlines()
blobs = {}
for commit in commits:
    for line in git('ls-tree', '-r', commit).decode().splitlines():
        meta, name = line.split('\t', 1)
        mode, typ, oid = meta.split()
        if typ == 'blob':
            blobs.setdefault(oid, set()).add(name)
history = []
for oid, names in blobs.items():
    data = git('cat-file', 'blob', oid)
    for name in sorted(names):
        history.extend(inspect(data, name))
# Deduplicate identical review signals across revisions; never emit matched values.
history = list({(x['file'], x['kind']): x for x in history}.values())
metadata = git('log', '--format=%ae%n%ce', 'origin/main..HEAD').decode().splitlines()
private_emails = set(x for x in metadata if x and not x.endswith('@users.noreply.github.com'))
package = None
if len(sys.argv) > 1:
    data = Path(sys.argv[1]).read_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.namelist() == SHIPPING, 'package must contain exactly the explicit shipping list'
        assert archive.testzip() is None
        for name in SHIPPING:
            assert archive.read(name) == Path(name).read_bytes(), 'package does not match reviewed source: ' + name
    package = {'sha256': hashlib.sha256(data).hexdigest(), 'entries': SHIPPING, 'CRC': 'pass', 'sourceBytesIdentical': True, 'findings': inspect(data, 'package')}
report = {'scope': 'Current package inputs, all tracked blobs in unpublished commit snapshots, nested ZIP entries up to 10 MiB, PNG metadata, and unpublished author/committer emails. Does not inspect browser profiles. Visual review and content provenance remain necessary.', 'packageInputs': inputs, 'unpublishedCommits': len(commits), 'uniqueBlobsScanned': len(blobs), 'historyFindings': history, 'nonNoreplyCommitEmailCount': len(private_emails), 'package': package}
print(json.dumps(report, indent=2))
blocked = any(x['findings'] for x in inputs) or history or private_emails or (package and package['findings'])
sys.exit(1 if blocked else 0)
