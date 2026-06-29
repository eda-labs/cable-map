// cable-map PDF — one page per node, from data.json (written alongside the panel SVGs).
#let data = json("data.json")

#let current = state("node", "")

// one node per page: header, front panel, cable table
#let node-page(node) = {
  current.update(node.name)
  grid(columns: (1fr, auto), align: (left + horizon, right + horizon),
    [#text(size: 15pt, weight: 700)[#node.name]#h(4.5pt)#text(size: 9.75pt, weight: 400, fill: rgb("#666666"))[#node.platform]],
    grid(columns: (auto, auto), column-gutter: 6pt, align: horizon,
      image("eda.svg", height: 21pt),
      text(size: 9.75pt, fill: rgb("#333333"), tracking: 0.225pt)[Cable Map],
    ),
  )
  v(8pt)
  if node.panel != "" {
    image(node.panel, width: 100%)
    v(12pt)
  }
  table(
    columns: (auto, 1fr, auto, auto, auto, 1fr),
    inset: 5pt, align: left + horizon, stroke: 0.4pt + rgb("#dddddd"),
    fill: (_, row) => if row == 0 { rgb("#e9edf2") } else if calc.odd(row) { rgb("#f6f8fa") } else { white },
    table.header([*Port*], [*Description*], [*Type*], [*Remote node*], [*Remote port*], [*LLDP neighbor*]),
    ..node.rows.flatten(),
  )
}

#set page(paper: "a4", flipped: true, margin: (x: 1.3cm, top: 1.1cm, bottom: 1.2cm),
  footer: context {
    set text(size: 8pt, fill: rgb("#888888"))
    grid(columns: (1fr, auto, 1fr),
      align(left)[#current.get()],
      align(center)[EDA Cable Map],
      align(right)[#counter(page).display("1")],
    )
  })
#set text(size: 9.5pt, font: "NokiaPureText")

#for (i, node) in data.nodes.enumerate() {
  node-page(node)
  if i < data.nodes.len() - 1 { pagebreak() }
}
