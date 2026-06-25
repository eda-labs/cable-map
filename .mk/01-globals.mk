ifndef DISABLE_MAKE_DEFAULTS
# Always run jobs in parallel (nproc on Linux, sysctl on macOS, 4 as a last resort)
NO_OF_JOBS ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
MAKEFLAGS += --jobs=$(NO_OF_JOBS)
# Force synced output per target always
MAKEFLAGS += --output-sync=target
endif

# Host properties section start
ARCH_QUERY ?= $(shell uname -m)
ifeq ($(ARCH_QUERY), x86_64)
	ARCH := amd64
else ifeq ($(ARCH_QUERY),$(filter $(ARCH_QUERY), arm64 aarch64))
	ARCH := arm64
else
	ARCH := $(ARCH_QUERY)
endif

# i.e Darwin / Linux
UNAME ?= $(shell uname)
# Lowercase - sane version
OS ?= $(shell echo "$(UNAME)" | tr '[:upper:]' '[:lower:]')
# Host properties section end

# Global lists to hold targets`
LIST_PUBLISH_APPS=
LIST_MOD_TIDY=
LIST_TESTS=
LIST_GENERATE=

LIST_BUILD_OPERATORS=
LIST_PACKAGE_OPERATORS=

LIST_BUILD_WORKFLOWS=
LIST_PACKAGE_WORKFLOWS=

# Help registry
HELP_TARGETS=

# Find all of the apps
APPS ?= $(shell find * -maxdepth 1 -type f -name manifest.yaml -exec dirname {} \; | sed 's|^\./||')
