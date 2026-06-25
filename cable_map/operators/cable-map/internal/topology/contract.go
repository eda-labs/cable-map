package topology

// ---- output contract -------------------------------------------------------------
//
// This file is the SINGLE SOURCE OF TRUTH for the JSON contract the React frontend consumes.
// `src/topology.gen.ts` is generated from these structs by tygo (`make ts-contract`); never edit
// the generated TS by hand. Field names + the load-bearing string literals ("interSwitch"/"edge",
// "ok"/"mismatch"/"none", the "lag-" prefix, role values) must stay stable.

// Node is keyed by `name`; it carries its own cable table, breakouts, and the TopoNode CR in `raw`.
type Node struct {
	Name      string                 `json:"name"`
	Platform  string                 `json:"platform"`
	OS        string                 `json:"os"`
	Role      string                 `json:"role"`
	Namespace string                 `json:"namespace,omitempty"`
	Version   string                 `json:"version,omitempty"`
	Labels    map[string]string      `json:"labels,omitempty"`
	Table     []Row                  `json:"table"`                // this node's cable matrix
	Breakouts map[string]Breakout    `json:"breakouts,omitempty"`  // cage id -> breakout split
	Raw       map[string]interface{} `json:"raw,omitempty"`        // the full TopoNode CR (details pane)
}

type Edge struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	Target     string `json:"target"`
	SourcePort string `json:"sourcePort"`
	TargetPort string `json:"targetPort"`
	Type       string `json:"type"`
}

type Row struct {
	Label      string `json:"label"`
	Desc       string `json:"desc"`
	RemoteNode string `json:"remoteNode"`
	RemotePort string `json:"remotePort"`
	Type       string `json:"type"`
	Lag        string `json:"lag,omitempty"`                  // LAG resource name (lag-…) when bundled
	Peer       string `json:"peer,omitempty"`                 // endpoint label for edge links with no remote node
	LldpStatus string `json:"lldpStatus" tstype:"LldpStatus"` // "ok" | "mismatch" | "none" — always emitted
	LldpPeer   string `json:"lldpPeer,omitempty"`             // "node port[, node port]"
}

type LagMember struct {
	Node string `json:"node"`
	Port string `json:"port"`
}

// LagInfo mirrors eda.ts: `multihomed` (members span >1 node) is the real ESI/MH test,
// not the presence of an esi stanza (EDA stamps esi:auto on every generated LAG).
type LagInfo struct {
	Name       string      `json:"name"`
	Lacp       bool        `json:"lacp"`
	Isl        bool        `json:"isl"`
	Multihomed bool        `json:"multihomed"`
	Mode       string      `json:"mode"`
	Members    []LagMember `json:"members"`
	Nodes      []string    `json:"nodes"`
}

// Breakout is a broken-out cage: how many channels it splits into and at what speed.
type Breakout struct {
	Channels int    `json:"channels"`
	Speed    string `json:"speed"`
}

type Topology struct {
	Nodes  []Node              `json:"nodes"`  // each node carries its own table/breakouts/raw CR
	Links  []Edge              `json:"links"`
	Lags   map[string]LagInfo  `json:"lags"`
	Labels map[string][]string `json:"labels"` // collected TopoNode label key -> sorted distinct values
}
