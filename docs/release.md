# Releasing Cable Map

Two images, one catalog entry:

- operator image `ghcr.io/eda-labs/cable-map/operators/cable-map:<version>` (`docker push`)
- app image `ghcr.io/eda-labs/cable-map:<version>` plus [eda-labs/catalog](https://github.com/eda-labs/catalog) entry (`edabuilder release`)

Version = tag on `spec.image` in `cable_map/manifest.yaml`.

Ref: [EDA docs: Build & publish](https://eda-docs.pages.dev/latest/development/apps/build-publish).

## Setup (once)

edabuilder, matching `builderVersion` in `PROJECT`:

```sh
V=v26.8.2; A=linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
gh release download $V -R nokia-eda/edabuilder -p "edabuilder-$V-$A*"
sha256sum -c edabuilder-$V-$A.sha256sum
install -m 0755 edabuilder-$V-$A ~/.local/bin/edabuilder
```

Older edabuilder versions record no `appImageDigest`, and EDA 26.8 refuses to install those
catalog entries. Go 1.26.4 or newer is required; `go.work` pins it.

EDK and frontend deps:

```sh
git clone https://github.com/nokia-eda/edk.git edk
(cd cable_map/frontend && pnpm install)
```

Logins (token needs `write:packages`; for a PAT, use a classic one, ghcr rejects fine-grained):

```sh
gh auth refresh -s write:packages
gh auth token | docker login ghcr.io -u <gh-user> --password-stdin
edabuilder login registry ghcr.io -u <gh-user> -p "$(gh auth token)"
edabuilder login git https://github.com/eda-labs/catalog -u <gh-user> -p "$(gh auth token)"
```

Releases are unsigned. EDA 26.8 rejects unsigned app images by default, so each cluster that
installs the app has to allow them, once. This applies to everything the cluster installs from
ghcr, not only Cable Map. The registry name can differ per cluster.

```sh
kubectl -n eda-system patch registries.appstore.eda.nokia.com eda-apps-registry \
  --type merge -p '{"spec":{"skipSignatureVerification":true}}'
```

Access:

- Write on both ghcr packages. They are not linked to the repo, so repo admin is not enough.
  Ask an org owner to add you under Package settings, Manage access, or to link the package
  to `eda-labs/cable-map` with inherited access.
- Push on `eda-labs/catalog`. `edabuilder release` commits and tags straight to `main`, no PR.
- Git `user.name` and `user.email` set. `edabuilder release` fails without them.

## Release

1. Be on up-to-date `main`, clean tree.
2. Set the same new tag on both `image:` lines in `cable_map/manifest.yaml`. Commit.
3. Run `make check`. It runs lint, frontend and Go tests, the contract-drift guard and a full
   build, checks that both tags match, then runs `edabuilder release --dry-run`. The dry run
   stages the catalog commit and tag in a temp clone. It pushes nothing. It also builds no app
   image, so it does not exercise the digest.
4. Run `make release`. It checks the tags, builds and pushes the operator image, then runs
   `edabuilder release`. That pushes the app image, commits the manifest and digest to the
   catalog, and creates tag `apps/cable-map.eda.labs/<version>`. The EDA Store installs from
   that tag.
5. Push the bump commit to `main`.
6. On a cluster that allows unsigned apps (see Setup), check that it accepts the release without
   installing anything:

   ```sh
   kubectl apply -f - <<EOF
   apiVersion: appstore.eda.nokia.com/v1
   kind: AppInstaller
   metadata:
     name: dryrun-cable-map
     namespace: eda-system
   spec:
     apps:
       - appId: cable-map.eda.labs
         catalog: eda-labs-catalog
         version: {type: semver, value: <version>}
     dryRun: true
     operation: install
   EOF
   kubectl -n eda-system get appinstaller dryrun-cable-map -o jsonpath='{.status}'
   kubectl -n eda-system delete appinstaller dryrun-cable-map
   ```

## Knobs

- `CATALOG`: catalog URL. Default from `PROJECT`.
- `RELEASE_FLAGS`: extra `edabuilder release` flags. `--force` overwrites a published
  version. `--verbose` shows debug logs.

Do not use `make cable_map-publish`. That generated target calls `edabuilder build-publish`,
which current edabuilder does not have.

## Without make

Push the operator image first. The app image pulls it in as a `dependencies.container`.

```sh
make image IMAGE=ghcr.io/eda-labs/cable-map/operators/cable-map:<version>
docker push ghcr.io/eda-labs/cable-map/operators/cable-map:<version>
edabuilder build-push --app cable_map
edabuilder publish app https://github.com/eda-labs/catalog --app cable_map
```
