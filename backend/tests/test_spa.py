from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

INDEX = "<!doctype html><title>Scrappy Records</title><div id=root></div>"


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX)
    (static / "assets" / "app-abc123.js").write_text("console.log('hi')")
    (static / "favicon.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("outside static")
    return static


@pytest.fixture
def spa_client(static_dir: Path) -> Iterator[TestClient]:
    with TestClient(create_app(static_dir=static_dir), base_url="http://127.0.0.1:8765") as c:
        yield c


def test_root_serves_index(spa_client: TestClient) -> None:
    response = spa_client.get("/")
    assert response.status_code == 200
    assert response.text == INDEX
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("path", ["/students/1", "/payments", "/students", "/no/such/page"])
def test_client_routes_fall_back_to_index(spa_client: TestClient, path: str) -> None:
    response = spa_client.get(path)
    assert response.status_code == 200
    assert response.text == INDEX


def test_static_files_are_served(spa_client: TestClient) -> None:
    js = spa_client.get("/assets/app-abc123.js")
    assert js.status_code == 200
    assert "console.log" in js.text
    assert "immutable" in js.headers["cache-control"]
    assert spa_client.get("/favicon.svg").text == "<svg/>"


def test_missing_asset_is_404_not_index(spa_client: TestClient) -> None:
    # e.g. an old JS chunk requested by a tab opened before an update
    response = spa_client.get("/assets/app-old999.js")
    assert response.status_code == 404
    assert INDEX not in response.text


def test_head_is_supported(spa_client: TestClient) -> None:
    for path in ["/", "/students/1", "/assets/app-abc123.js"]:
        response = spa_client.head(path)
        assert response.status_code == 200, path
        assert response.content == b""


def test_unknown_api_paths_are_404_json(spa_client: TestClient) -> None:
    response = spa_client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


def test_api_still_works_with_static(spa_client: TestClient) -> None:
    assert spa_client.get("/api/health").json()["status"] == "ok"


def test_no_path_traversal(spa_client: TestClient) -> None:
    response = spa_client.get("/..%2Fsecret.txt")
    assert "outside static" not in response.text


def test_missing_build_gives_helpful_404(tmp_path: Path) -> None:
    with TestClient(
        create_app(static_dir=tmp_path / "nope"), base_url="http://127.0.0.1:8765"
    ) as c:
        response = c.get("/")
        assert response.status_code == 404
        assert "make build" in response.json()["detail"]
