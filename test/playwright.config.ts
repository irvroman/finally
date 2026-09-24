import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL || "http://localhost:8000";

// All specs share one app instance and one SQLite DB (single-user, user_id="default"),
// so they run serially. Tests assert on deltas rather than absolute state wherever
// they can, so they tolerate a DB that already holds data from earlier runs.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  // "fresh" runs first (it checks the seeded state when FRESH_DB=true), then the
  // API tests, then the UI tests.
  projects: [
    {
      name: "fresh",
      testMatch: "e2e/fresh-start.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    { name: "api", testMatch: "api/**/*.spec.ts", dependencies: ["fresh"] },
    {
      name: "e2e",
      testMatch: "e2e/**/*.spec.ts",
      testIgnore: "e2e/fresh-start.spec.ts",
      dependencies: ["api"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
});
