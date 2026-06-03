((lexical_declaration
  (variable_declarator
    name: (identifier) @declaration.name
    value: (_) @declaration.value)) @declaration
  (#set! declaration.kind "local"))
