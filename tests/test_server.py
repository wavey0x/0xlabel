from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from server import create_app, load_token

ADDRESS = '0x' + 'ab' * 20
TOKEN = 'test-only-token'
HEADERS = {'Authorization': f'Bearer {TOKEN}'}


@pytest.fixture
def book(tmp_path):
    return TestClient(create_app(tmp_path / 'book.sqlite3', TOKEN), headers=HEADERS)


def put(book, labels, version=None, scope='global', address=ADDRESS):
    return book.put(f'/labels/{scope}/{address}', json={'labels': labels, 'version': version})


def test_every_operation_requires_token(tmp_path):
    with TestClient(create_app(tmp_path / 'book.sqlite3', TOKEN)) as client:
        for headers in [{}, {'Authorization': 'Bearer wrong'}, {'Authorization': 'Basic nope'}]:
            assert client.get('/labels', headers=headers).status_code == 401
            assert client.put(f'/labels/global/{ADDRESS}', json={'labels': ['Private']}, headers=headers).status_code == 401
        assert client.get('/labels', headers=HEADERS).json() == {'records': []}


def test_ranking_scope_deletion_and_conflicts(book):
    global_record = put(book, [' Treasury ', 'Operations']).json()['record']
    assert global_record['labels'] == ['Treasury', 'Operations']
    assert global_record['address'] == ADDRESS
    network = put(book, ['Base Treasury'], scope='eip155:8453').json()['record']
    assert len(book.get('/labels').json()['records']) == 2
    assert put(book, ['stale']).status_code == 409
    changed = put(book, ['Operations', 'Treasury'], global_record['version']).json()['record']
    assert changed['version'] != global_record['version']
    stale = put(book, [], global_record['version'])
    assert stale.status_code == 409 and stale.json()['current'] == changed
    assert put(book, [], network['version'], 'eip155:8453').json() == {'record': None}
    assert book.get('/labels').json()['records'] == [changed]
    assert put(book, [], changed['version']).json() == {'record': None}
    assert book.get('/labels').json() == {'records': []}


@pytest.mark.parametrize('labels', [[''], ['a', ' A '], ['x' * 81], ['a\ninside'], ['x'] * 33, [None]])
def test_invalid_lists_do_not_change_book(book, labels):
    assert put(book, labels).status_code == 422
    assert book.get('/labels').json() == {'records': []}


@pytest.mark.parametrize('scope,address', [('eip155:0', ADDRESS), ('eip155:01', ADDRESS), ('other', ADDRESS), ('global', '0x1234'), ('global', ADDRESS + 'a')])
def test_invalid_identity_is_rejected(book, scope, address):
    assert put(book, ['Name'], scope=scope, address=address).status_code == 422


def test_concurrent_edits_have_one_winner(book):
    original = put(book, ['First']).json()['record']
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(lambda name: put(book, [name], original['version']), ['One', 'Two']))
    assert sorted(response.status_code for response in results) == [200, 409]
    winner = next(response.json()['record'] for response in results if response.status_code == 200)
    assert book.get('/labels').json()['records'] == [winner]


def test_write_requires_an_explicit_conflict_token(book):
    assert book.put(f'/labels/global/{ADDRESS}', json={'labels': ['Name']}).status_code == 422
    assert book.get('/labels').json() == {'records': []}


def test_restart_and_independent_installations(tmp_path):
    local_path, remote_path = tmp_path / 'local.sqlite3', tmp_path / 'remote.sqlite3'
    local = TestClient(create_app(local_path, TOKEN), headers=HEADERS)
    saved = put(local, ['Local only']).json()['record']
    remote = TestClient(create_app(remote_path, TOKEN), headers=HEADERS)
    assert remote.get('/labels').json() == {'records': []}
    put(remote, ['Remote only'])
    for _ in range(3):
        remote.get('/labels'); local.get('/labels')
    assert local.get('/labels').json()['records'] == [saved]
    assert TestClient(create_app(local_path, TOKEN), headers=HEADERS).get('/labels').json()['records'] == [saved]


def test_token_created_once_with_private_file(tmp_path, monkeypatch):
    monkeypatch.delenv('OXLABEL_TOKEN', raising=False)
    first = load_token(tmp_path)
    assert len(first) >= 32 and load_token(tmp_path) == first
    assert (tmp_path / 'token.txt').stat().st_mode & 0o777 == 0o600
