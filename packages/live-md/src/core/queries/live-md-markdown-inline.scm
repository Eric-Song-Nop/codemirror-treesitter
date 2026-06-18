(code_span) @mark.inlineCode
(code_span_delimiter) @syntax
(emphasis) @mark.emphasis
(emphasis_delimiter) @syntax
(strikethrough) @mark.strike
(strong_emphasis) @mark.strong
(uri_autolink) @uriAutolink

((inline_link
  .
  (link_text) @link.text
  (link_destination)? @link.destination
  (link_title)?
  .) @link @feature
  (#set! liveMd.kind "link"))

((image
  .
  (image_description)? @image.description
  (link_destination)? @image.destination
  (link_title)?
  .) @image @feature
  (#set! liveMd.kind "image"))

((latex_block
  .
  (latex_span_delimiter) @latex.open
  (latex_span_delimiter) @latex.close
  .) @latex @feature
  (#set! liveMd.kind "latex")
  (#set! injection.language "latex"))
