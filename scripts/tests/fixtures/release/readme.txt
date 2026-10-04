# Fixture

| Variable | What it does |
| --- | --- |
| `PPP_REGISTRY` / `PPP_TAG` | Which image to run. Pin `PPP_TAG` to a release (`v0.1.0`) or a commit SHA. |

The object store was still there in v0.1.0, which is history and stays as written.

```bash
docker manifest inspect ghcr.io/octo/ppp-app:v0.1.0
```
