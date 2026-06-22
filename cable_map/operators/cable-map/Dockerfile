ARG TARGET_IMAGE=alpine:3.23

FROM ${TARGET_IMAGE}

# Chromium is required for the /pdf endpoint (chromedp renders the SPA's /print page).
# nss/freetype/harfbuzz/fontconfig + a base TTF are the minimum to render text headless.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto \
      fontconfig

WORKDIR /operators

# The operator binary is built on the host by `make cable-map-cable-map-build` with the React
# SPA already go:embed-ed into it (see scripts/build-image.sh).
COPY build/operators/cable-map/cable-map /operators/cable-map

ENV PORT=8080 \
    HOME=/tmp \
    CHROMEDP_NO_SANDBOX=1

EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/operators/cable-map"]
