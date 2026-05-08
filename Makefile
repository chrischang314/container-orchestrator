SHELL := /bin/bash

.PHONY: help bootstrap deploy status switch-cluster k3s-up k3s-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Install platform components on the active kubectl context
	./platform/bootstrap.sh

deploy: ## Helm-upgrade-install every app under apps/
	./scripts/deploy.sh

status: ## Show cluster + app status
	./scripts/status.sh

switch-cluster: ## Toggle kubectl context: docker-desktop <-> k3s
	./scripts/switch-cluster.sh

k3s-up: ## Bring up the k3s Lima VM (first Mac Mini = server)
	./platform/k3s/up.sh

k3s-down: ## Stop the k3s Lima VM
	limactl stop k3s-server || true
