"""Only this laptop's own pages may use the app (app/local_only.py): DNS rebinding and
cross-site requests are refused on every endpoint, API and UI files alike."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

STUDENT = {"name": "Ananya Rao", "monthly_fee_paise": 150000, "joined_month": "2026-05"}
REFUSED = {"detail": "Only Scrappy Records itself, on this laptop's address, can do this."}


@pytest.fixture
def ui(tmp_path: Path) -> Iterator[TestClient]:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>Scrappy</title>")
    with TestClient(create_app(static_dir=static), base_url="http://127.0.0.1:8765") as c:
        yield c


@pytest.mark.parametrize(
    "host",
    [
        "evil.com:8765",  # DNS rebinding: a website's name pointed at 127.0.0.1
        "evil.com",
        "127.0.0.1:9999",  # another port
        "127.0.0.1",
        "localhost",
        "127.0.0.2:8765",
        "",
    ],
)
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/students"),
        ("get", "/api/health"),
        ("get", "/api/dashboard"),
        ("post", "/api/students"),
        ("get", "/"),
        ("get", "/students/3"),
        ("get", "/api/openapi.json"),
    ],
)
def test_other_hosts_are_refused_everywhere(
    ui: TestClient, host: str, method: str, path: str
) -> None:
    body = STUDENT if method == "post" else None
    response = ui.request(method, path, headers={"Host": host}, json=body)
    assert response.status_code == 403
    assert response.json() == REFUSED


@pytest.mark.parametrize("host", ["127.0.0.1:8765", "localhost:8765", "LOCALHOST:8765"])
def test_the_app_itself_is_answered(ui: TestClient, host: str) -> None:
    assert ui.get("/api/students", headers={"Host": host}).status_code == 200
    assert ui.get("/", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({}, 201),  # not a browser (launcher, tests): no Origin, no Sec-Fetch-Site
        ({"Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"}, 201),
        ({"Origin": "http://localhost:8765"}, 201),
        ({"Origin": "https://evil.example"}, 403),
        ({"Origin": "http://127.0.0.1:9999"}, 403),
        ({"Origin": "null"}, 403),
        ({"Sec-Fetch-Site": "cross-site"}, 403),
        ({"Sec-Fetch-Site": "same-site"}, 403),
        ({"Sec-Fetch-Site": "none"}, 201),
    ],
)
def test_changes_only_from_the_app(ui: TestClient, headers: dict[str, str], status: int) -> None:
    assert ui.post("/api/students", json=STUDENT, headers=headers).status_code == status


def test_every_kind_of_change_is_checked(ui: TestClient) -> None:
    student = ui.post("/api/students", json=STUDENT).json()
    evil = {"Origin": "https://evil.example"}
    sid = student["id"]
    assert ui.patch(f"/api/students/{sid}", json={"name": "X"}, headers=evil).status_code == 403
    assert ui.delete(f"/api/students/{sid}", headers=evil).status_code == 403
    assert ui.post("/api/payments", json={}, headers=evil).status_code == 403
    assert ui.options("/api/students", headers=evil).status_code == 403
    assert ui.get(f"/api/students/{sid}").json()["name"] == "Ananya Rao"  # nothing changed


def test_reading_with_another_origin_is_left_to_the_browser(ui: TestClient) -> None:
    # A GET changes nothing; the browser won't show another site the answer (no CORS headers).
    response = ui.get("/api/students", headers={"Origin": "https://evil.example"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
