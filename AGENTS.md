# Container-Orchestrator Agent Instructions

## Purpose

This repo manages the local Kubernetes platform and app deployments. Common operations are adding worker nodes and deploying containers through the reusable Helm chart.

## Use The Skill

Use the global `container-orchestrator-ops` skill for worker-node onboarding and container deployment.

## Commands

- Bootstrap platform: `make bootstrap`
- Deploy apps: `make deploy`
- Status: `make status`
- Helm lint one app: `helm lint charts/app -f apps/<app>/values.yaml`
- Rollout check: `kubectl rollout status deployment/<deployment-name> --timeout=120s`

## Adding Worker Nodes

- Read `HANDOFF.md`, `platform/k3s/MIGRATION.md`, and `platform/k3s/lima-agent.yaml` before changing node setup.
- Do not print, commit, or paste the K3s node token into tracked files.
- Prefer kubeconfig, SSH keys, certificates, or stored local credentials over manual password prompts.
- After a node joins, verify `kubectl get nodes -o wide`, labels, taints, and whether it should host ServiceLB with `svccontroller.k3s.cattle.io/enablelb=true`.
- Update docs with node role, hostname, IP, labels, hardware, and workload placement.

## Deploying Containers

- App deployments belong under `apps/<name>/values.yaml` and should use `charts/app`.
- Confirm image repository, tag, port, health checks, ingress hostname, node selector, secrets, PVCs, and resource needs.
- Run Helm lint, deploy, rollout status, pod logs if needed, and LAN/health endpoint verification.
- A deployment is not complete until the container is healthy and responding.

## Secrets

- Never commit GHCR credentials, kube tokens, SSH private keys, cert private keys, or app secrets.
- Store secrets in Kubernetes Secrets, local OS credential storage, ignored `.env` files, or the relevant provider keychain.
