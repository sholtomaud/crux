# --------------------------------------------------
# Configuration
# --------------------------------------------------

IMAGE_APP := crux
CONTAINER_BIN := container

WORKDIR := /app

# Node 25 macOS arm64 tarball for cross-compiled SEA
NODE_VERSION  := 25.8.0
NODE_MACOS_URL := https://nodejs.org/dist/v$(NODE_VERSION)/node-v$(NODE_VERSION)-darwin-arm64.tar.gz
NODE_MACOS_BIN := dist/node-macos-arm64

RUN := $(CONTAINER_BIN) run -it --rm \
	-v "$(PWD):$(WORKDIR)" \
	-v node_modules_cache:$(WORKDIR)/node_modules \
	-p 5173:5173 \
	-p 8765:8765 \
	$(IMAGE_APP)

# Non-interactive variant (no -t) for CI and agent use
# GH_TOKEN injected at runtime so gh CLI works inside the container without keychain
RUN_CI := $(CONTAINER_BIN) run -i --rm \
	-v "$(PWD):$(WORKDIR)" \
	-v node_modules_cache:$(WORKDIR)/node_modules \
	-e GH_TOKEN=$(shell gh auth token 2>/dev/null) \
	$(IMAGE_APP)

# High-memory variant for SEA builds (postject WASM is memory-hungry)
RUN_BIG := $(CONTAINER_BIN) run -i --rm \
	--memory 2g \
	-v "$(PWD):$(WORKDIR)" \
	-v node_modules_cache:$(WORKDIR)/node_modules \
	$(IMAGE_APP)

.PHONY: \
	all help bootstrap image ensure-deps \
	dev build preview \
	test test-agent lint format validate \
	shell install ci \
	mcpb-validate mcpb-pack \
	bundle sea-linux sea-macos install \
	stop clean clean-volumes

# --------------------------------------------------
# Default Target
# --------------------------------------------------

all: validate ## Run full validation suite

# --------------------------------------------------
# Help (self-documenting CLI)
# --------------------------------------------------

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

# --------------------------------------------------
# Container Image
# --------------------------------------------------

image: ## Build dev container image
	@echo "🔨 Building container image..."
	$(CONTAINER_BIN) build -t $(IMAGE_APP) .

# --------------------------------------------------
# Dependency Management
# --------------------------------------------------

ensure-deps: ## Install dependencies if missing
	@echo "📦 Ensuring dependencies..."
	$(RUN_CI) sh -c '[ -f node_modules/.package-lock.json ] || npm ci'

deps-update: ## Update package-lock.json inside container (run after adding new deps)
	@echo "📦 Updating dependencies..."
	$(RUN_CI) npm install

install: test sea-macos ## Run tests, build macOS SEA, install to ~/bin, configure PATH + VSCode MCP
	@# PATH
	@grep -q '$$HOME/bin\|~/bin' $(HOME)/.zshrc 2>/dev/null || \
		{ echo 'export PATH="$$HOME/bin:$$PATH"' >> $(HOME)/.zshrc && \
		  echo "Added ~/bin to PATH in ~/.zshrc (restart shell or: source ~/.zshrc)"; }
	@# VSCode settings.json
	python3 scripts/vscode-mcp-install.py
	@echo "Done. Run: crux --help"

bootstrap: image ensure-deps ## First-time project setup

# --------------------------------------------------
# App Lifecycle (mirrors package.json)
# --------------------------------------------------

dev: ensure-deps ## Start Vite dev server
	@echo "🚀 Starting dev server..."
	$(RUN) npm run dev

build: ensure-deps ## Production build
	@echo "🏗️ Building application..."
	$(RUN) npm run build

preview: ensure-deps ## Preview production build
	@echo "👀 Preview build..."
	$(RUN) npm run preview

test: ensure-deps ## Run test suite
	@echo "🧪 Running tests..."
	$(RUN_CI) npm test

test-agent: ensure-deps ## Agent-compatible tests
	@echo "🤖 Running agent tests..."
	$(RUN_CI) npm run test:agent

lint: ensure-deps ## Run ESLint
	@echo "🔍 Linting..."
	$(RUN_CI) npm run lint

format: ensure-deps ## Format code
	@echo "🎨 Formatting..."
	$(RUN_CI) npm run format

validate: ensure-deps ## Lint + test validation
	@echo "✅ Running validation suite..."
	$(RUN_CI) sh -c "npm run lint && npm test"

# --------------------------------------------------
# MCPB Bundle
# --------------------------------------------------

mcpb-validate: ensure-deps ## Validate manifest.json against MCPB spec
	@echo "🔍 Validating MCPB manifest..."
	$(RUN_CI) sh -c "npm install -g @anthropic-ai/mcpb --quiet 2>/dev/null; mcpb validate manifest.json"

mcpb-pack: mcpb-validate ## Pack crux.mcpb bundle
	@echo "📦 Packing crux.mcpb..."
	$(RUN_CI) sh -c "npm install -g @anthropic-ai/mcpb --quiet 2>/dev/null; mcpb pack . crux.mcpb"

# --------------------------------------------------
# SEA — Single Executable Application
# --------------------------------------------------

# Step 1 shared by both sea targets: bundle TS → CJS, create blob
SEA_PREP := $(RUN_CI) sh -c '\
	mkdir -p dist && \
	npm run bundle && \
	node --experimental-sea-config sea-config.json'

bundle: ensure-deps ## Bundle TypeScript → dist/crux.cjs (esbuild)
	@echo "📦 Bundling..."
	$(RUN_CI) sh -c 'mkdir -p dist && npm run bundle'

sea-linux: ensure-deps ## Build Linux arm64 SEA → dist/crux-linux-arm64
	@echo "🔨 Building Linux SEA..."
	$(RUN_CI) sh -c '\
		mkdir -p dist && \
		npm run bundle && \
		node --experimental-sea-config sea-config.json && \
		cp "$$(node -e "process.stdout.write(process.execPath)")" dist/crux-linux-arm64 && \
		npx --yes postject dist/crux-linux-arm64 NODE_SEA_BLOB dist/sea-prep.blob \
			--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 && \
		chmod +x dist/crux-linux-arm64'
	@echo "✅  dist/crux-linux-arm64 ready"

sea-macos: ensure-deps ## Build macOS arm64 SEA → dist/crux-macos-arm64, strip quarantine, install to ~/bin
	@echo "Building macOS arm64 SEA..."
	$(RUN_BIG) sh -c '\
		mkdir -p dist && \
		npm run bundle && \
		node --experimental-sea-config sea-config.json && \
		curl -fsSL "$(NODE_MACOS_URL)" \
			| tar -xz -C dist --strip-components=2 \
				"node-v$(NODE_VERSION)-darwin-arm64/bin/node" && \
		npx --yes postject dist/node NODE_SEA_BLOB dist/sea-prep.blob \
			--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
			--macho-segment-name NODE_SEA && \
		mv dist/node dist/crux-macos-arm64'
	chmod +x dist/crux-macos-arm64
	mkdir -p $(HOME)/bin
	cp dist/crux-macos-arm64 $(HOME)/bin/crux
	codesign --sign - $(HOME)/bin/crux
	xattr -d com.apple.quarantine $(HOME)/bin/crux 2>/dev/null || true
	@echo "crux installed → $(HOME)/bin/crux"
	@echo "VSCode MCP entry (add to settings.json):"
	@echo '  "mcp": { "servers": { "crux": { "command": "$(HOME)/bin/crux" } } }'

# --------------------------------------------------
# CI Parity
# --------------------------------------------------

ci: validate build ## CI pipeline entrypoint

# --------------------------------------------------
# Developer Utilities
# --------------------------------------------------

shell: ## Open interactive shell in container
	$(RUN) bash

# --------------------------------------------------
# Cleanup
# --------------------------------------------------

stop: ## Stop running container (if named)
	-$(CONTAINER_BIN) stop $(IMAGE_APP)

clean-volumes: ## Remove dependency cache
	-$(CONTAINER_BIN) volume rm node_modules_cache
	-$(CONTAINER_BIN) volume prune -f

clean: stop clean-volumes ## Full cleanup
	-$(CONTAINER_BIN) image rm $(IMAGE_APP)