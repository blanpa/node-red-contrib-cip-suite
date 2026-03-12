/**
 * Node-RED Settings for Docker test environment.
 */
module.exports = {
  flowFile: "flows.json",
  flowFilePretty: true,

  uiPort: process.env.PORT || 1880,
  uiHost: "0.0.0.0",

  diagnostics: {
    enabled: true,
    ui: true
  },

  logging: {
    console: {
      level: "info",
      metrics: false,
      audit: false
    }
  },

  editorTheme: {
    projects: {
      enabled: false
    }
  }
};
