(fenced_code_block
  .
  (fenced_code_block_delimiter) @codeFence.delimiter
  (info_string (language) @codeFence.language)?
  (block_continuation)?
  (code_fence_content)? @codeFence.content
  (fenced_code_block_delimiter)? @codeFence.delimiter
  .) @codeFence
