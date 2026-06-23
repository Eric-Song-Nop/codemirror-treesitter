((atx_heading . (atx_h1_marker) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "1"))
((atx_heading . (atx_h2_marker) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "2"))
((atx_heading . (atx_h3_marker) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "3"))
((atx_heading . (atx_h4_marker) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "4"))
((atx_heading . (atx_h5_marker) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "5"))
((atx_heading . (atx_h6_marker) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "6"))
((setext_heading heading_content: (paragraph) (setext_h1_underline) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "1"))
((setext_heading heading_content: (paragraph) (setext_h2_underline) @heading.marker) @heading @feature
  (#set! liveMd.kind "heading")
  (#set! heading.level "2"))

(block_continuation) @syntax
(block_quote) @blockquote
(block_quote_marker) @syntax
(list_item) @list.item
(list_marker_dot) @list.marker
(list_marker_minus) @list.marker
(list_marker_parenthesis) @list.marker
(list_marker_plus) @list.marker
(list_marker_star) @list.marker
(task_list_marker_checked) @task.checked
(task_list_marker_unchecked) @task.unchecked
((thematic_break) @rule @feature
  (#set! liveMd.kind "rule"))

((fenced_code_block
  .
  (fenced_code_block_delimiter) @codeFence.open
  (info_string (language) @codeFence.language)?
  (block_continuation)?
  (code_fence_content)? @codeFence.content
  (fenced_code_block_delimiter)? @codeFence.close
  .) @codeFence @feature
  (#set! liveMd.kind "codeFence"))

((pipe_table) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table (pipe_table_header (pipe_table_cell) @table.header.cell) @table.header) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table (pipe_table_delimiter_row) @table.delimiter.row) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table
  (pipe_table_delimiter_row
    (pipe_table_delimiter_cell
      (pipe_table_align_left)? @table.align.left
      (pipe_table_align_right)? @table.align.right) @table.delimiter.cell)) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table (pipe_table_row (pipe_table_cell) @table.row.cell) @table.row) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table (pipe_table_header "|" @table.pipe)) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table (pipe_table_delimiter_row "|" @table.pipe)) @table @feature
  (#set! liveMd.kind "table"))
((pipe_table (pipe_table_row "|" @table.pipe)) @table @feature
  (#set! liveMd.kind "table"))
