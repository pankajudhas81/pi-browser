# Default: lint, build, test
default: all

# Type-check / compile TypeScript
build:
    pnpm run build

# Run tests
test:
    pnpm test

# Lint with oxlint + oxfmt
lint:
    pnpm run lint

# Auto-fix lint issues
fix:
    pnpm run lint:fix

# Format with oxfmt
format:
    pnpm run format

# Remove compiled output
clean:
    rm -rf dist

# Lint + build + test
all: lint build test

# Bump version, tag, and push. CI publishes to npm automatically.
# npm version creates an annotated tag + commit; --follow-tags pushes both.
# Usage: just release 0.1.1
release version:
    npm version {{version}} --message "🔖 Release %s"
    git push origin main --follow-tags
