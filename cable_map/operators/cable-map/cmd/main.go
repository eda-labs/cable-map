/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// cable-map is an EDA operator app that serves the cable-map topology / front-panel UI.
// It is read-only: it streams toponode/topolink/interface state from the EDA State
// Aggregator via the EDK (no Kubernetes API, no reconcilers) and serves the embedded
// React SPA + its JSON/SSE API. Because there is nothing to reconcile, it runs a plain
// HTTP server rather than a controller-runtime manager.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"eda.dev/edk/pkg/utils/logger"

	"cable-map.eda.labs/cable-map/operators/cable-map/internal/eda"
	"cable-map.eda.labs/cable-map/operators/cable-map/internal/server"
)

func main() {
	log := logger.NewLog()
	log.Info("starting cable-map operator")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start the EDA state streams; data fills in as the State Aggregator syncs.
	store := eda.NewStore(ctx)

	if err := server.New(store, port).Run(ctx); err != nil {
		log.Error(err, "http server failed")
		os.Exit(1)
	}
	log.Info("cable-map stopped")
}
