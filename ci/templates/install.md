# Installing the CI/CD workflow into an app repo

Per-app, one-time setup that takes ~2 minutes.

## 1. Copy the workflow

In the target app repo (e.g. `chrischang314/local-llm`):

```sh
mkdir -p .github/workflows
curl -fsSL \
  https://raw.githubusercontent.com/chrischang314/container-orchestrator/main/ci/templates/docker-build-push.yml \
  -o .github/workflows/build-and-push.yml
```

(Or just copy the file from this repo.)

## 2. Customize the matrix

Open `.github/workflows/build-and-push.yml` and edit the `matrix.service`
list to match the Dockerfile contexts in your repo:

```yaml
matrix:
  service:
    - name: backend
      context: ./backend
    - name: frontend
      context: ./frontend
```

For a single-service repo with one Dockerfile at the root:

```yaml
matrix:
  service:
    - name: app
      context: .
```

## 3. Replace the test command

Find this block:

```yaml
- name: Run tests
  run: |
    echo "TODO: replace with the repo's real test command."
    exit 0
```

Replace with whatever runs your tests, e.g.:

```yaml
- name: Run tests
  run: |
    pip install -r backend/requirements.txt
    pytest backend
```

## 4. Enable Actions write permission for GHCR

In the GitHub UI for the target repo:
**Settings → Actions → General → Workflow permissions → Read and write
permissions** → Save.

This lets the built-in `GITHUB_TOKEN` push to `ghcr.io`. No PAT needed.

## 5. Commit, push, watch

```sh
git add .github/workflows/build-and-push.yml
git commit -m "Add CI: build & push to GHCR"
git push
```

The first push triggers the workflow. After it succeeds, your image is at
`ghcr.io/<owner>/<repo>/<service>:main`. Within ~5 minutes Keel will roll the
matching Deployment in the cluster.

## 6. Make the package public (optional)

If the app repo itself is public, GHCR packages start out **private**. To
let the cluster pull without a credential:
- GitHub → your profile → **Packages** → click the package → **Package
  settings** → **Change visibility** → Public.

Or keep it private and rely on the `ghcr-creds` secret created by
`platform/components/ghcr-secret.sh`. Either works.
