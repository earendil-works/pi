# Fork and Git remotes

## Clone-only (no fork yet)

A single remote named `origin` pointing at `https://github.com/badlogic/pi-mono.git` is normal. Update with:

```bash
git pull origin main
```

Or add a second remote for clarity:

```bash
git remote add upstream https://github.com/badlogic/pi-mono.git
git fetch upstream
git merge upstream/main
```

## After creating your GitHub fork

1. Fork **badlogic/pi-mono** on GitHub.
2. Point **origin** at your fork and keep **upstream** for the official repo:

```bash
git remote rename origin upstream
git remote add origin https://github.com/<you>/pi-mono.git
git fetch origin
```

Or keep `origin` as your fork and add `upstream` to badlogic (either layout is fine as long as both roles are clear).

3. Push your distribution branch (e.g. `mom-distribution` or `main`) to **origin** only.
4. Merge or rebase from **upstream/main** regularly (see [UPSTREAM.md](./UPSTREAM.md)).
