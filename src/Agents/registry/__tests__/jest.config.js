module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/.."],
  testMatch: ["**/__tests__/AgentRegistry.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  testTimeout: 30000,
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  // Don't use the stellar mock setup for these tests
  setupFilesAfterEnv: [],
};
