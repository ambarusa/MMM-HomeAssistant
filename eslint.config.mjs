import eslintPluginJs from "@eslint/js"
import globals from "globals"

export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        Log: "readonly",
        MM: "readonly",
        Module: "readonly"
      }
    },
    rules: {
      ...eslintPluginJs.configs.recommended.rules,
      "no-prototype-builtins": "off",
      "no-unused-vars": ["error", { args: "none" }]
    }
  }
]
