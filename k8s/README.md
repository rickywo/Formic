# Formic — Kubernetes Deployment

Deploy Formic to a Kubernetes cluster using the manifests in this directory.

## Resources

| File | Kind | Name |
|---|---|---|
| `namespace.yaml` | Namespace | `formic` |
| `configmap.yaml` | ConfigMap | `formic-config` |
| `secret.yaml` | Secret | `formic-secrets` |
| `pvc.yaml` | PersistentVolumeClaim | `formic-workspace` |
| `deployment.yaml` | Deployment | `formic` |
| `service.yaml` | Service | `formic` |
| `kustomization.yaml` | Kustomization | — |

All resources are created in the **`formic`** namespace.

## Prerequisites

- A Kubernetes cluster (v1.25+)
- `kubectl` configured to access the cluster
- A Docker image built and accessible to the cluster:

```bash
docker build -t formic:latest .
```

> Update the `image` field in `deployment.yaml` to point to your registry
> (e.g. `ghcr.io/rickywo/formic:latest`).

## Secrets

Create the secret before deploying. Provide the key(s) for the agent you plan to use:

```bash
kubectl create namespace formic

kubectl create secret generic formic-secrets \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=GITHUB_TOKEN=ghp_... \
  -n formic
```

| Key | Required when |
|---|---|
| `ANTHROPIC_API_KEY` | `AGENT_TYPE=claude` (default) |
| `GITHUB_TOKEN` | `AGENT_TYPE=copilot` |

## Deploy

```bash
kubectl apply -k k8s/
```

Verify the rollout:

```bash
kubectl -n formic rollout status deployment/formic
```

## Access

Forward port 8000 to your local machine:

```bash
kubectl -n formic port-forward svc/formic 8000:8000
```

Then open <http://localhost:8000>.

## Configuration

Edit `configmap.yaml` to change runtime settings:

| Key | Default | Description |
|---|---|---|
| `PORT` | `8000` | Server listen port |
| `WORKSPACE_PATH` | `/app/workspace` | Workspace directory inside the container |
| `AGENT_TYPE` | `claude` | AI agent — `claude` or `copilot` |

After editing, re-apply and restart:

```bash
kubectl apply -k k8s/
kubectl -n formic rollout restart deployment/formic
```

## Cleanup

```bash
kubectl delete -k k8s/
```
