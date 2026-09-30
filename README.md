# Scrappy Records

A small, private app for someone who runs a class (dance, music, tuition…) to see **who has paid
for which month** — all in one place, on their own laptop. No accounts, no cloud, no internet
needed once installed.

- **Dashboard:** who hasn't paid this month, what's still owed from earlier months, and who
  overpaid.
- **Students:** add, edit and archive students, each with a profile and their full payment history.
- **Payments:** log a payment for a student and month; see, sort and fix every payment.

Everything is stored on the laptop itself and backed up automatically every day.

---

## Install on Windows (for the person using the app)

You do **not** need to install anything first.

1. Press the **Windows key**, type **PowerShell**, and press **Enter**.
2. Copy this line, paste it into the blue window (right-click pastes), and press **Enter**:

   ```powershell
   [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
   ```

3. Wait for the message **"Scrappy Records is installed"**. The app opens in your browser.
4. From now on, double-click **Scrappy Records** on your Desktop to open it.

To **update** later, repeat step 2 — your data is kept.

More help: [Install on Windows](docs/runbooks/install-windows.md) ·
[Using the app](docs/runbooks/daily-use.md) ·
[Backups](docs/runbooks/backup-and-restore.md) ·
[Something's wrong](docs/runbooks/troubleshooting.md)

Mac: see [Install on Mac](docs/runbooks/install-mac.md).

---

## For developers

```bash
git clone https://github.com/srikdhruv/scrappy-business-records.git
cd scrappy-business-records
make setup   # installs backend (uv) and frontend (npm) dependencies
make dev     # API on :8765 with reload + UI on :5173 (open this one)
make test    # all tests
```

Requirements: [uv](https://docs.astral.sh/uv/), Node 24 (or 22.22+), GNU make (macOS/Linux, or Git Bash on
Windows).

| Doc | What's in it |
|---|---|
| [Product requirements](docs/product/prd.md) | MVP scope, user stories, ledger rules |
| [Future features](docs/product/future-features.md) | Everything deliberately left out of the MVP |
| [Architecture](docs/architecture.md) | How the one-process stack works on the laptop |
| [Data model](docs/data-model.md) | Tables and API shapes |
| [ADRs](docs/adr/) | Why we chose what we chose |
| [Development runbook](docs/runbooks/development.md) | Day-to-day dev workflow |
| [Release runbook](docs/runbooks/release.md) | Cutting a release that users install |
| [Contributing](CONTRIBUTING.md) | Branches, PRs, CI |

License: [MIT](LICENSE).
