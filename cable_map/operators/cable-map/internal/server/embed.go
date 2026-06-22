package server

import (
	"embed"
	"io/fs"
)

// The built React SPA. A real bundle is copied in at build time (see the Makefile/Dockerfile);
// the committed dist/index.html placeholder keeps `go build` working before `vite build` runs.
//
//go:embed all:dist
var distFS embed.FS

func distRoot() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err) // dist is embedded at build time; this cannot happen at runtime
	}
	return sub
}
