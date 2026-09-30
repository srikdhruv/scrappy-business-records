from importlib.metadata import version

from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "app": "scrappy-records",
        "version": version("scrappy-records"),
        "status": "ok",
    }


def test_startup_creates_folders_and_database(client: TestClient, scrappy_home) -> None:
    assert (scrappy_home / "data" / "records.db").is_file()
    assert (scrappy_home / "logs").is_dir()
    assert (scrappy_home / "backups").is_dir()


def test_openapi_and_docs_are_under_api(client: TestClient) -> None:
    schema = client.get("/api/openapi.json").json()
    assert schema["info"]["title"] == "Scrappy Records"
    assert client.get("/api/docs").status_code == 200
