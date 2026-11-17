module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  // Several e2e suites start the simulator on 44818, so they must not run side by side.
  maxWorkers: 1,
};
