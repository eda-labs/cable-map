ARG TARGET_IMAGE=alpine:3.23

FROM ${TARGET_IMAGE}

# The /pdf endpoint renders with Typst (the static musl binary below). The operator embeds the
# NokiaPureText fonts + template and passes them via --font-path; font-noto is just a glyph fallback.
ARG TYPST_VERSION=0.15.0
RUN apk add --no-cache ca-certificates font-noto qpdf \
 && apk add --no-cache --virtual .typst-dl wget xz \
 && wget -qO /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
 && xz -dc /tmp/typst.tar.xz | tar -x -C /tmp \
 && mv /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && rm -rf /tmp/typst* \
 && apk del .typst-dl \
 && typst --version

WORKDIR /operators

# The operator binary is built on the host by `make cable-map-cable-map-build` with the React
# SPA (minus the front-panel SVGs) already go:embed-ed into it (see scripts/build-image.sh).
COPY build/operators/cable-map/cable-map /operators/cable-map

# Front-panel stencils are served from disk at /frontpanel/* (STENCIL_DIR), not embedded in the
# binary — a cached layer copied straight from the operator's own stencil dir.
COPY operators/cable-map/frontpanel /stencils

ENV PORT=8080 \
    HOME=/tmp \
    STENCIL_DIR=/stencils

EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/operators/cable-map"]
