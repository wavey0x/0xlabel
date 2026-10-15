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


def put(book, tags, version=None, scope='global', address=ADDRESS):
    return book.put(f'/tags/{scope}/{address}', json={'tags': tags, 'version': version})



def batch(book, changes):
    return book.put('/tags', json={'changes': changes})


def test_a_file_lands_whole_or_not_at_all(book):
    other = '0x' + 'cd' * 20
    answer = batch(book, [
        {'address': ADDRESS, 'scope': 'global', 'tags': ['Treasury'], 'version': None},
        {'address': other, 'scope': 'eip155:8453', 'tags': ['Payroll'], 'version': None},
    ])
    assert answer.status_code == 200
    saved = answer.json()['records']
    assert [item['tags'] for item in saved] == [['Treasury'], ['Payroll']]
    assert len(book.get('/tags').json()['records']) == 2

    # One stale version in the batch, and nothing in it is written.
    refused = batch(book, [
        {'address': ADDRESS, 'scope': 'global', 'tags': ['Renamed'], 'version': saved[0]['version']},
        {'address': other, 'scope': 'eip155:8453', 'tags': ['Renamed too'], 'version': 'stale'},
    ])
    assert refused.status_code == 409
    assert refused.json()['conflicts'] == [{'address': other, 'scope': 'eip155:8453', 'current': saved[1]}]
    assert sorted(item['tags'][0] for item in book.get('/tags').json()['records']) == ['Payroll', 'Treasury']
    assert batch(book, [{'address': ADDRESS, 'scope': 'global', 'tags': ['Twice'], 'version': None},
                        {'address': ADDRESS, 'scope': 'global', 'tags': ['Again'], 'version': None}]).status_code == 422


def test_a_book_that_has_not_changed_is_not_sent_again(book):
    first = book.get('/tags')
    mark = first.headers['ETag']
    assert mark and first.json() == {'records': []}
    again = book.get('/tags', headers={'If-None-Match': mark})
    assert again.status_code == 304 and again.content == b'' and again.headers['ETag'] == mark

    saved = put(book, ['Treasury']).json()['record']
    changed = book.get('/tags', headers={'If-None-Match': mark})
    assert changed.status_code == 200 and changed.json()['records'] == [saved]
    assert changed.headers['ETag'] != mark
    assert book.get('/tags', headers={'If-None-Match': changed.headers['ETag']}).status_code == 304

    # A deletion changes the book even though it leaves nothing behind.
    put(book, [], saved['version'])
    assert book.get('/tags', headers={'If-None-Match': changed.headers['ETag']}).status_code == 200


def test_every_operation_requires_token(tmp_path):
    with TestClient(create_app(tmp_path / 'book.sqlite3', TOKEN)) as client:
        for headers in [{}, {'Authorization': 'Bearer wrong'}, {'Authorization': 'Basic nope'}]:
            assert client.get('/tags', headers=headers).status_code == 401
            assert client.put(f'/tags/global/{ADDRESS}', json={'tags': ['Private']}, headers=headers).status_code == 401
        assert client.get('/tags', headers=HEADERS).json() == {'records': []}


def test_ranking_scope_deletion_and_conflicts(book):
    global_record = put(book, [' Treasury ', 'Operations']).json()['record']
    assert global_record['tags'] == ['Treasury', 'Operations']
    assert global_record['address'] == ADDRESS
    network = put(book, ['Base Treasury'], scope='eip155:8453').json()['record']
    assert len(book.get('/tags').json()['records']) == 2
    assert put(book, ['stale']).status_code == 409
    changed = put(book, ['Operations', 'Treasury'], global_record['version']).json()['record']
    assert changed['version'] != global_record['version']
    stale = put(book, [], global_record['version'])
    assert stale.status_code == 409 and stale.json()['current'] == changed
    assert put(book, [], network['version'], 'eip155:8453').json() == {'record': None}
    assert book.get('/tags').json()['records'] == [changed]
    assert put(book, [], changed['version']).json() == {'record': None}
    assert book.get('/tags').json() == {'records': []}


@pytest.mark.parametrize('tags', [[''], ['a', ' A '], ['x' * 81], ['a\ninside'], ['x'] * 33, [None]])
def test_invalid_lists_do_not_change_book(book, tags):
    assert put(book, tags).status_code == 422
    assert book.get('/tags').json() == {'records': []}


@pytest.mark.parametrize('scope,address', [('eip155:0', ADDRESS), ('eip155:01', ADDRESS), ('other', ADDRESS), ('global', '0x1234'), ('global', ADDRESS + 'a')])
def test_invalid_identity_is_rejected(book, scope, address):
    assert put(book, ['Name'], scope=scope, address=address).status_code == 422


def test_concurrent_edits_have_one_winner(book):
    original = put(book, ['First']).json()['record']
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(lambda name: put(book, [name], original['version']), ['One', 'Two']))
    assert sorted(response.status_code for response in results) == [200, 409]
    winner = next(response.json()['record'] for response in results if response.status_code == 200)
    assert book.get('/tags').json()['records'] == [winner]


def test_write_requires_an_explicit_conflict_token(book):
    assert book.put(f'/tags/global/{ADDRESS}', json={'tags': ['Name']}).status_code == 422
    assert book.get('/tags').json() == {'records': []}


def test_restart_and_independent_installations(tmp_path):
    local_path, remote_path = tmp_path / 'local.sqlite3', tmp_path / 'remote.sqlite3'
    local = TestClient(create_app(local_path, TOKEN), headers=HEADERS)
    saved = put(local, ['Local only']).json()['record']
    remote = TestClient(create_app(remote_path, TOKEN), headers=HEADERS)
    assert remote.get('/tags').json() == {'records': []}
    put(remote, ['Remote only'])
    for _ in range(3):
        remote.get('/tags'); local.get('/tags')
    assert local.get('/tags').json()['records'] == [saved]
    assert TestClient(create_app(local_path, TOKEN), headers=HEADERS).get('/tags').json()['records'] == [saved]


def test_token_created_once_with_private_file(tmp_path, monkeypatch):
    monkeypatch.delenv('OXTAGGER_TOKEN', raising=False)
    first = load_token(tmp_path)
    assert len(first) >= 32 and load_token(tmp_path) == first
    assert (tmp_path / 'token.txt').stat().st_mode & 0o777 == 0o600


def test_connect_link_carries_the_key_in_the_fragment():
    """The extension reads the key from the fragment, which is never sent to us."""
    from server import connect_link

    link = connect_link("http://127.0.0.1:8712/", "sk-example")
    assert link == "http://127.0.0.1:8712#key=sk-example"
    base, _, fragment = link.partition("#")
    assert "sk-example" not in base, "a key in the path or query would reach the server"
    assert fragment == "key=sk-example"
