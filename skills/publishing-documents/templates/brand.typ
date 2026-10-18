// PDF theme for publish.ts: pandoc's Typst template calls conf() with the document's metadata.
// Once copied into a project it belongs to that project: change the values below to its brand.
#let accent = rgb("#1f4e79")
#let body-font = ("Libertinus Serif",)
#let code-font = ("DejaVu Sans Mono",)

#let conf(
  title: none,
  subtitle: none,
  authors: (),
  thanks: none,
  date: none,
  lang: "en",
  region: none,
  paper: "a4",
  font: (),
  fontsize: 11pt,
  cols: 1,
  ..rest,
  doc,
) = {
  set document(title: title)
  set text(lang: lang, font: if font.len() > 0 { font } else { body-font }, size: fontsize)
  set text(region: region) if region != none
  set par(justify: true)
  set page(paper: paper, margin: (x: 2.2cm, y: 2.5cm))
  show raw: set text(font: code-font, size: 0.9em)
  show link: set text(fill: accent)
  show heading: set text(fill: accent)
  show heading.where(level: 1): it => { v(0.6em); it; v(0.2em) }
  show outline: it => { it; pagebreak() }

  // Cover. pandoc forwards only fixed fields to conf(), so publish.ts passes the audience and version as `thanks`.
  page(header: none, footer: none)[
    #v(25%)
    #line(length: 100%, stroke: 3pt + accent)
    #v(1em)
    #text(size: 28pt, weight: "bold", fill: accent, title)
    #if subtitle != none {
      v(0.4em)
      text(size: 16pt, subtitle)
    }
    #v(2em)
    #if thanks != none [#text(size: 11pt, thanks) \ ]
    #for a in authors [#text(size: 11pt, a.name) \ ]
    #v(1fr)
    #if date != none { text(size: 11pt, fill: accent, date) }
  ]

  set page(
    header: context {
      set text(size: 9pt, fill: accent)
      title
      h(1fr)
      if subtitle != none { subtitle }
      v(-0.6em)
      line(length: 100%, stroke: 0.5pt + accent)
    },
    footer: context {
      set align(center)
      set text(size: 9pt)
      counter(page).display("1 / 1", both: true)
    },
  )
  counter(page).update(1)
  if cols == 1 { doc } else { columns(cols, doc) }
}
