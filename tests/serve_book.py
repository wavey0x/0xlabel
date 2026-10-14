"""Ephemeral, test-only book. Never opens the user's actual database or token."""
import argparse
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import create_app
import uvicorn

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--tls', action='store_true')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='0xlabel-test-') as directory:
    root = Path(directory)
    options = {}
    if args.tls:
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        options = {'ssl_keyfile': str(root / 'key.pem'), 'ssl_certfile': str(root / 'cert.pem')}
    uvicorn.run(create_app(root / 'book.sqlite3', 'test-only-token'), host='127.0.0.1', port=args.port, access_log=False, **options)
