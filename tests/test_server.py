from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from server import create_app, load_token

ADDRESS = '0x' + 'ab' * 20
TOKEN = 'test-only-token'
HEADERS = {'Authorization': f'Bearer {TOKEN}'}


def test_proxy_identity_is_explicit_and_only_trusted_from_loopback(tmp_path):
    identity = {'Tailscale-User-Login': 'me@example.com'}
    with TestClient(create_app(tmp_path / 'key.sqlite3', TOKEN), client=('127.0.0.1', 1234)) as client:
        assert client.get('/tags', headers=identity).status_code == 401
    app = create_app(tmp_path / 'proxy.sqlite3', TOKEN,
                     tailscale_login='me@example.com', public_url='https://electro.example/0xtagger/')
    with TestClient(app, client=('127.0.0.1', 1234)) as client:
        assert client.get('/tags', headers=identity).status_code == 200
        assert client.get('/tags').status_code == 401
        assert client.get('/tags', headers={'Tailscale-User-Login': 'someone@example.com'}).status_code == 401
        assert client.get('/tags', headers=HEADERS).status_code == 200
    with TestClient(app, client=('100.64.0.2', 1234)) as client:
        assert client.get('/tags', headers=identity).status_code == 401


def test_proxy_writes_require_the_browser_origin_and_keys_still_work(tmp_path):
    app = create_app(tmp_path / 'book.sqlite3', TOKEN,
                     tailscale_login='me@example.com', public_url='https://electro.example/0xtagger/')
    identity = {'Tailscale-User-Login': 'me@example.com'}
    with TestClient(app, client=('127.0.0.1', 1234)) as client:
        for origin in [None, 'null', 'https://other.example']:
            headers = identity | ({'Origin': origin} if origin else {})
            assert client.put(f'/tags/global/{ADDRESS}', headers=headers, json={'tags': ['Unwanted']}).status_code == 403
        assert client.get('/tags', headers=identity).json()['records'] == []
        saved = client.put(f'/tags/global/{ADDRESS}', headers=identity | {'Origin': 'https://electro.example'},
                           json={'tags': ['Mine'], 'version': None})
        assert saved.status_code == 200
        assert client.put(f'/tags/global/{ADDRESS}', headers=HEADERS,
                          json={'tags': ['From the extension'], 'version': saved.json()['record']['version']}).status_code == 200
        preflight = client.options('/tags', headers={'Origin': 'https://other.example',
                                   'Access-Control-Request-Method': 'PUT'})
        assert 'access-control-allow-origin' not in preflight.headers


def test_hosted_ui_ships_its_assets_but_no_private_or_extension_files(tmp_path):
    from server import WEB_ASSETS
    with TestClient(create_app(tmp_path / 'tags.sqlite3', TOKEN), headers=HEADERS) as client:
        page = client.get('/')
        assert page.status_code == 200 and 'book-web.js' in page.text and TOKEN not in page.text
        for asset in WEB_ASSETS:
            assert client.get('/' + asset).status_code == 200, asset
        for path in ['tags.sqlite3', 'token.txt', 'server.py', 'manifest.json', 'background.js', 'book-extension.js', '../server.py']:
            assert client.get('/' + path).status_code == 404, path
    # The checks above carry the key, which is how an unauthenticated asset
    # went unnoticed: a caller with none could read every file the page needs
    # and learn from the reply what was listening.
    with TestClient(create_app(tmp_path / 'closed.sqlite3', TOKEN)) as nobody:
        assert nobody.get('/').status_code == 401
        for asset in WEB_ASSETS:
            assert nobody.get('/' + asset).status_code == 401, asset


def test_proxy_mode_requires_a_loopback_bind_and_explicit_browser_url(tmp_path, monkeypatch):
    import server
    with pytest.raises(ValueError, match='browser-facing'):
        create_app(tmp_path / 'book.sqlite3', TOKEN, tailscale_login='me@example.com')
    for url in ['http://electro.example/', 'https://name:password@electro.example/', 'https://electro.example/#key=secret']:
        with pytest.raises(ValueError, match='browser-facing'):
            create_app(tmp_path / 'book.sqlite3', TOKEN, tailscale_login='me@example.com', public_url=url)
    monkeypatch.setattr('sys.argv', ['0xtagger', '--host', '0.0.0.0', '--tailscale-login', 'me@example.com'])
    with pytest.raises(SystemExit):
        server.main()


@pytest.fixture
def book(tmp_path):
    return TestClient(create_app(tmp_path / 'book.sqlite3', TOKEN), headers=HEADERS)


def put(book, tags, version=None, scope='global', address=ADDRESS, source=None):
    body = {'tags': tags, 'version': version}
    if source is not None:
        body['source'] = source
    return book.put(f'/tags/{scope}/{address}', json=body)



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


def test_a_source_is_settled_when_a_record_is_created(book):
    """Where a record came from is history, so a later write never rewrites it."""
    first = put(book, ['Treasury'], source='safe:address-book').json()['record']
    assert first['source'] == 'safe:address-book'

    second = put(book, ['Our treasury'], version=first['version'], source='etherscan:page')
    assert second.json()['record']['source'] == 'safe:address-book'
    assert book.get('/tags').json()['records'][0]['source'] == 'safe:address-book'


def test_a_record_written_before_the_column_existed_can_still_be_attributed(book):
    """Settled at creation is not the same as unanswerable forever."""
    plain = put(book, ['Treasury']).json()['record']
    assert 'source' not in plain

    named = put(book, ['Treasury'], version=plain['version'], source='safe:page')
    assert named.json()['record']['source'] == 'safe:page'
    assert book.get('/tags').json()['records'][0]['source'] == 'safe:page'


def test_a_record_composed_by_hand_carries_no_source(book):
    assert 'source' not in put(book, ['Treasury']).json()['record']


def test_a_source_a_record_cannot_carry_is_refused(book):
    assert put(book, ['Treasury'], source='evil.example').status_code == 422


def test_arkham_source_survives_a_batch_write(book):
    answer = batch(book, [{'address': ADDRESS, 'scope': 'eip155:1',
                           'tags': ['Gate Hot Wallet'], 'version': None,
                           'only_if_unnamed': True, 'source': 'arkham:api'}])
    assert answer.status_code == 200
    assert book.get('/tags').json()['records'][0]['source'] == 'arkham:api'


def test_a_batch_carrying_nothing_moves_no_revision(book):
    put(book, ['Treasury'])
    mark = book.get('/tags').headers['etag']
    assert batch(book, []).status_code == 200
    assert book.get('/tags').headers['etag'] == mark


def test_a_book_from_an_older_build_refuses_to_open(tmp_path):
    """Greenfield: an old book is not upgraded in place, it is named and refused."""
    import sqlite3
    path = tmp_path / 'old.sqlite3'
    with sqlite3.connect(path) as connection:
        connection.execute(
            'CREATE TABLE tags (address TEXT NOT NULL, scope TEXT NOT NULL, '
            'tags_json TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (address, scope))'
        )
    with pytest.raises(RuntimeError, match='older 0xtagger'):
        create_app(path, TOKEN)


def test_a_name_on_every_network_refuses_an_import_meant_to_be_new(book):
    """A name added elsewhere after a review opened must not be shadowed by it.

    Only the book can check this without a race: the browser's copy of it can
    already be out of date by the moment the batch arrives.
    """
    covering = put(book, ['Everywhere']).json()['record']

    refused = batch(book, [{'address': ADDRESS, 'scope': 'eip155:8453',
                            'tags': ['Base treasury'], 'version': None, 'only_if_unnamed': True}])
    assert refused.status_code == 409
    assert refused.json()['conflicts'][0]['current']['version'] == covering['version']
    assert len(book.get('/tags').json()['records']) == 1

    # Copying a book is not an import, so it is free to carry both rows.
    allowed = batch(book, [{'address': ADDRESS, 'scope': 'eip155:8453',
                            'tags': ['Base treasury'], 'version': None}])
    assert allowed.status_code == 200
    assert len(book.get('/tags').json()['records']) == 2


def test_an_import_meant_to_be_new_still_lands_where_nothing_names_it(book):
    other = '0x' + 'cd' * 20
    answer = batch(book, [{'address': other, 'scope': 'eip155:8453',
                           'tags': ['Payroll'], 'version': None, 'only_if_unnamed': True}])
    assert answer.status_code == 200
    assert answer.json()['records'][0]['tags'] == ['Payroll']
